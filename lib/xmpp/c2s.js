var EventEmitter = require('events').EventEmitter;
var Connection = require('./connection');
var JID = require('./jid').JID;
var ltx = require('ltx');
var util = require('util');
var crypto = require('crypto');
var SRV = require('./srv');
var net = require('net');
var sasl = require('./sasl');
var fs = require('fs');

var NS_CLIENT = 'jabber:client';
var NS_XMPP_SASL = 'urn:ietf:params:xml:ns:xmpp-sasl';
var NS_XMPP_TLS  = 'urn:ietf:params:xml:ns:xmpp-tls';
var NS_REGISTER = 'jabber:iq:register';
var NS_SESSION = 'urn:ietf:params:xml:ns:xmpp-session';
var NS_BIND = 'urn:ietf:params:xml:ns:xmpp-bind';

/**
* params:
*   options : port on which to listen to C2S connections */
function C2SServer(options) {
    var self = this;
    this.options = options;

    // And now start listening to connections on the port provided as an option.
    net.createServer(function (inStream) {
        self.acceptConnection(inStream);
    }).listen(options.port);

    // Load TLS key material
    if (options.tls) {
        this.credentials = { key: fs.readFileSync(options.tls.keyPath, 'ascii'), cert: fs.readFileSync(options.tls.certPath, 'ascii')};
    }
    
    // Router
    this.router = {};
}

util.inherits(C2SServer, EventEmitter);
exports.C2SServer = C2SServer;

/**
* Called upon TCP connection from client. */
C2SServer.prototype.acceptConnection = function(socket) {
    var client = new C2SStream(socket, this);
    this.emit("connect", client);
    socket.addListener('error', function() { });
    client.addListener('error', function() { });

    var self = this;
    client.addListener('online', function() {
        self.router.registerRoute(client.jid, client);
        
        client.addListener('disconnect', function() {
            self.router.unregisterRoute(client.jid, client);
        });
    });
};


function C2SStream(socket, server) {
    var self = this;
    this.authenticated = false;
    this.server = server;
    Connection.Connection.call(this, socket);

    this.xmlns[''] = NS_CLIENT;
    this.xmppVersion = '1.0';

    this.startParser();

    this.addListener('streamStart', function(streamAttrs) {
        self.startStream(streamAttrs);
    });

    this.addListener('rawStanza', function(stanza) {
        self.onRawStanza(stanza);
    });

    this.addListener('close', function() {
        // We need to remove this user's connection, if authed:
        if (self.jid) {
            self.emit("disconnect", self);
            self.server.emit("disconnect", self);
            self.server.router.unregisterRoute(self.jid, self);
        }
    });
    
    this.addListener('outStanza', function(stanza) {
        self.send(stanza);
    });
    
    return self;
};
util.inherits(C2SStream, Connection.Connection);

C2SStream.prototype.startStream = function(streamAttrs) {
    var attrs = {};
    for(var k in this.xmlns) {
        if (this.xmlns.hasOwnProperty(k)) {
            if (!k)
            attrs.xmlns = this.xmlns[k];
            else
            attrs['xmlns:' + k] = this.xmlns[k];
        }
    }
    if (this.xmppVersion)
        attrs.version = this.xmppVersion;
    if (this.streamTo)
        attrs.to = this.streamTo;

    this.streamId = generateId();

    attrs.id = this.streamId;

    attrs.from = this.server.options.domain;

    var el = new ltx.Element('stream:stream', attrs);
    // make it non-empty to cut the closing tag
    el.t(' ');
    var s = el.toString();
    this.send(s.substr(0, s.indexOf(' </stream:stream>')));

    this.sendFeatures();
};

C2SStream.prototype.sendFeatures = function() {
    var features = new ltx.Element('stream:features');
    if (!this.authenticated) {
        // TLS
        if (this.server.options.tls && !this.socket.encrypted) {
            features.c("starttls", {xmlns: NS_XMPP_TLS}).c("required");
        }
        this.mechanisms = sasl.availableMechanisms();

        var mechanismsEl = features.c("mechanisms", { xmlns: NS_XMPP_SASL});
        this.mechanisms.forEach(function(mech) {
            mechanismsEl.c("mechanism").t(mech.name);
	});
    }
    else {
        features.c("bind", {xmlns: NS_BIND});
        features.c("session", {xmlns: NS_SESSION});
    }
    this.send(features);
};

C2SStream.prototype.onRawStanza = function(stanza) {
    var bind, session;

    if (this.jid) {
        stanza.attrs.from = this.jid.toString();
    }

    if (stanza.is('starttls', NS_XMPP_TLS)) {
        this.send(new ltx.Element('proceed', { xmlns: Connection.NS_XMPP_TLS }));
        this.setSecure(this.server.credentials, true);
    }
    else if(stanza.is('auth', NS_XMPP_SASL)) {
        this.onAuth(stanza);
    }
    else if (stanza.is('iq') &&
            stanza.attrs.type == 'set' &&
            (bind = stanza.getChild('bind', NS_BIND))) {
        this.onBind(stanza);
    }
    else if (stanza.is('iq') &&
            stanza.attrs.type == 'set' &&
            (session = stanza.getChild('session', NS_SESSION))) {
        this.onSession(stanza);
    }
    else if (stanza.is('iq') && stanza.getChild('query', NS_REGISTER)) {
        this.onRegistration(stanza);
    }
    else {
        if (this.authenticated) {
            this.server.emit('inStanza', this, stanza); // We make the distinction between inStanza (coming from the C2SStream), and outStanza (going to the C2SStream)
        }
    }
};

C2SStream.prototype.authenticate = function(username, password) {
    var self = this;
    var jid = new JID(username, this.server.options.domain);
    this.server.emit('authenticate', jid, password, this, function(authenticated) {
        if (authenticated) {
            self.emit('auth-success', jid);
            self.jid = jid;
            self.authenticated = true;
            self.stopParser();
            self.send(new ltx.Element("success", { xmlns: NS_XMPP_SASL }));
            self.startParser();
        }
        else {
            self.emit('auth-failure', jid);
            self.send(new ltx.Element("failure", { xmlns: NS_XMPP_SASL }));
        }
    });
};

C2SStream.prototype.onAuth = function(stanza) {
    var matchingMechs = this.mechanisms.filter(function(mech) {
	return mech.name === stanza.attrs.mechanism;
    });

    if (matchingMechs[0]) {
	this.mechanism = matchingMechs[0];
	this.mechanism.authServer(decode64(stanza.getText()), this);
    } else {
	this.send(new ltx.Element("failure", { xmlns: NS_XMPP_SASL })); // We're doomed. Not right auth mechanism offered.
    }
};

C2SStream.prototype.onRegistration = function(stanza) {
    var self = this;
    var register = stanza.getChild('query', NS_REGISTER);
    var reply = new ltx.Element('iq', { type: 'result' });
    if (stanza.attrs.id)
	reply.attrs.id = stanza.attrs.id;

    if (stanza.attrs.type === 'get') {
	reply.c('query', { xmlns: NS_REGISTER }).
	    c("instructions").t("Choose a username and password for use with this service. ").up().
	    c("username").up().
            c("password");
    }
    else if (stanza.attrs.type === 'set') {
        var jid = new JID(register.getChildText('username'), this.server.options.domain)
        self.server.emit('register', jid, register.getChildText('password'), self, function(registered, reason) {
            if (registered) {
                self.emit('registration-success', self.jid);
            }
            else {
                self.emit('registration-failure', jid);
                reply.attrs.type = "error";
                reply.c("error", { code: reason.code, type: reason.type }).c('text', { xmlns: "urn:ietf:params:xml:ns:xmpp-stanzas" }).t(reason.text);
            }
        });
    }
    self.send(reply);
};

C2SStream.prototype.onBind = function(stanza) {
    var bind = stanza.getChild('bind', NS_BIND);
    var resource;
    if ((resource = bind.getChild("resource", NS_BIND))) {
        this.jid.setResource(resource.getText());
    }
    else {
        this.jid.setResource(generateId());
    }

    this.send(new ltx.Element("iq", { type:"result", id: stanza.attrs.id }).
	      c("bind", { xmlns: NS_BIND }).
	      c("jid").t(this.jid.toString())
	     );
};

C2SStream.prototype.onSession = function(stanza) {
    this.send(new ltx.Element("iq", { type:"result", id: stanza.attrs.id }).
	      c("session", { xmlns: NS_SESSION})
	     );
    this.emit('online');
};


function generateId() {
    var r = new Buffer(16);
    for(var i = 0; i < r.length; i++) {
        r[i] = 48 + Math.floor(Math.random() * 10);  // '0'..'9'
    }
    return r.toString();
};
function decode64(encoded) {
    return (new Buffer(encoded, 'base64')).toString('utf8');
}
function encode64(decoded) {
    return (new Buffer(decoded, 'utf8')).toString('base64');
}


