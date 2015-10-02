var express = require('express');
var logger = require('morgan');
var bodyParser = require('body-parser');
colors = require('colors');

async = require('async');
Models = require('telepat-models');
redis = require('redis');

var security = require('./controllers/security');
var adminRoute = require('./controllers/admin');
var objectRoute = require('./controllers/object');
var userRoute = require('./controllers/user');
var contextRoute = require('./controllers/context');
var deviceRoute = require('./controllers/device');

var dbConnected = false;
app = express();

app.set('port', process.env.PORT || 3000);

app.disable('x-powered-by');

app.use('/documentation', express.static(__dirname+'/documentation'));

process.title = 'octopus-api';

var envVariables = {
	TP_MSG_QUE: process.env.TP_MSG_QUE,
	TP_REDIS_HOST: process.env.TP_REDIS_HOST,
	TP_REDIS_PORT: process.env.TP_REDIS_PORT,
	TP_MAIN_DB: process.env.TP_MAIN_DB,
	TP_PW_SALT: process.env.TP_PW_SALT
};

var validEnvVariables = true;
var mainConfiguration = {};
var redisConfig = {};
var mainDatabase = null;
var messagingClient = null;

for(var varName in envVariables) {
	if (envVariables[varName] === undefined) {
		console.log('Missing'.yellow+' environment variable "'+varName+'". Trying configuration file.');
		try {
			mainConfiguration = require('./config.json');
		} catch (e) {
			if (e.code === 'MODULE_NOT_FOUND') {
				console.log('Fatal error:'.red+' configuration file is missing or not accessible. ' +
					'Please add a configuration file from the example.');
				process.exit(-1);
			} else
				throw e;
		}

		validEnvVariables = false;
		break;
	}
}

if (validEnvVariables) {
	messagingClient = envVariables.TP_MSG_QUE;
	redisConfig = {
		host: envVariables.TP_REDIS_HOST,
		port: envVariables.TP_REDIS_PORT
	};
	mainDatabase = envVariables.TP_MAIN_DB;
	//is null just so the adapter constructor will try to check envVariables
	mainConfiguration[mainDatabase] = null;
	mainConfiguration.passwordSalt = envVariables.TP_PW_SALT;
} else {
	app.kafkaConfig = mainConfiguration.kafka;
	//backwards compatiblity for config.json files.
	if(mainConfiguration['password_salt'] !== undefined)
		mainConfiguration.passwordSalt = mainConfiguration['password_salt'];
	redisConfig = mainConfiguration.redis;
	if(mainConfiguration['main_database'] !== undefined)
		mainConfiguration.mainDatabase = mainConfiguration['main_database'];
	mainDatabase = mainConfiguration.mainDatabase;
	messagingClient = mainConfiguration.message_queue;
}

Models.Application.datasource = new Models.Datasource();
Models.Application.datasource.setMainDatabase(new Models[mainDatabase](mainConfiguration[mainDatabase]));

if(mainConfiguration.passwordSalt === undefined || mainConfiguration.passwordSalt === "" || mainConfiguration.passwordSalt === null) {
	console.log('Please add salt configuration via TP_PW_SALT or config.json');
	process.exit(-1);
}
app.set('password_salt', mainConfiguration.passwordSalt);

app.applications = {};

app.use(function(req, res, next) {
	if (dbConnected)
		return next();
	res.type('application/json');
	next(new Models.TelepatError(Models.TelepatError.errors.ServerNotAvailable));
});

var loadApplications = function() {
	Models.Application.getAll(function(err, results) {
		if (err) {
			console.log('Fatal error: '.red+' in retrieving all aplications', err);
			process.exit(-1);
		}

		async.each(results, function(item, c){
			app.applications[item.id] = item;
			c();
		});
	});
};

var linkMiddlewaresAndRoutes = function() {
	app.use(security.corsValidation);
	app.use(security.contentTypeValidation);
	app.use(logger('dev'));
	/*Automatically parses request body from json string to object*/
	app.use(bodyParser.json());
	app.use('/admin', adminRoute);
	app.use('/object', objectRoute);
	app.use('/user', userRoute);
	app.use('/context', contextRoute);
	app.use('/device', deviceRoute);
};

var linkErrorHandlingMiddlewares = function() {
	// error handlers
	// catch 404 and forward to error handler
	app.use(function(req, res, next) {
		next(new Models.TelepatError(Models.TelepatError.errors.NoRouteAvailable));
	});

	app.use(function(err, req, res, next) {
		var responseBody = {};

		if (!(err instanceof Models.TelepatError)) {
			err = new Models.TelepatError(Models.TelepatError.errors.ServerFailure, [err.message]);
		}

		res.status(err.status);
		responseBody.code = err.code;
		responseBody.message = err.message;
		responseBody.status = err.status;

		if (err.stack && app.get('env') === 'development')
			responseBody.stack = err.stack;

		res.json(responseBody).end();
	});
};

var monitorUsrSignals = function() {
	//signal sent by nodemon when restarting the server
	process.on('SIGUSR2', function() {
		app.kafkaClient.close();
	});
};

var OnServicesConnect = function() {
	dbConnected = true;
	loadApplications();
	linkMiddlewaresAndRoutes();
	linkErrorHandlingMiddlewares();
	monitorUsrSignals();
};

async.waterfall([
	function(callback) {
		Models.Application.datasource.dataStorage.onReady(function() {
			callback();
		});
	},
	function(callback) {
		if (Models.Application.redisClient)
			Models.Application.redisClient = null;

		Models.Application.redisClient = redis.createClient(redisConfig.port, redisConfig.host);
		Models.Application.redisClient.on('error', function(err) {
			console.log('Failed'.bold.red+' connecting to Redis "'+redisConfig.host+'": '+err.message);
			console.log('Retrying...');
		});
		Models.Application.redisClient.on('ready', function() {
			console.log('Client connected to Redis.'.green);
			callback();
		});
	},
	function(callback) {
		console.log('Waiting for Messaging Client connection...');

		var clientConfiguration = mainConfiguration[messagingClient];

		/**
		 * @type {MessagingClient}
		 */
		app.messagingClient = new Models[messagingClient](clientConfiguration, 'telepat-api');
		app.messagingClient.onReady(callback);
	}
], OnServicesConnect);

module.exports = app;
