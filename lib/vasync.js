/*
 * vasync.js: utilities for observable asynchronous control flow
 */

var mod_assert = require('assert');
var mod_util = require('util');
var mod_verror = require('verror');

/*
 * Public interface
 */
exports.parallel = parallel;
exports.forEachParallel = forEachParallel;
exports.pipeline = pipeline;

/*
 * Represents a collection of errors for the purpose of consumers that generally
 * only deal with one error.  Callers can extract the individual errors
 * contained in this object, but may also just treat it as a normal single
 * error, in which case a summary message will be printed.
 */
function MultiError(errors)
{
	mod_assert.ok(errors.length > 0);
	this.ase_errors = errors;

	mod_verror.VError.call(this, errors[0], 'first of %d error%s',
	    errors.length, errors.length == 1 ? '' : 's');
}

mod_util.inherits(MultiError, mod_verror.VError);


/*
 * Given a set of functions that complete asynchronously using the standard
 * callback(err, result) pattern, invoke them all and merge the results.  See
 * README.md for details.
 */
function parallel(args, callback)
{
	var funcs, rv, doneOne, i;

	funcs = args['funcs'];

	rv = {
	    'operations': new Array(funcs.length),
	    'ndone': 0,
	    'nerrors': 0
	};

	if (funcs.length === 0) {
		process.nextTick(function () { callback(null, rv); });
		return (rv);
	}

	doneOne = function (entry) {
		return (function (err, result) {
			mod_assert.equal(entry['status'], 'pending');

			entry['err'] = err;
			entry['result'] = result;
			entry['status'] = err ? 'fail' : 'ok';

			if (err)
				rv['nerrors']++;

			if (++rv['ndone'] < funcs.length)
				return;

			var errors = rv['operations'].filter(function (ent) {
				return (ent['status'] == 'fail');
			}).map(function (ent) { return (ent['err']); });

			if (errors.length > 0)
				callback(new MultiError(errors), rv);
			else
				callback();
		});
	};

	for (i = 0; i < funcs.length; i++) {
		rv['operations'][i] = {
			'func': funcs[i],
			'status': 'pending'
		};

		funcs[i](doneOne(rv['operations'][i]));
	}

	return (rv);
}

/*
 * Exactly like parallel, except that the input is specified as a single
 * function to invoke on N different inputs (rather than N functions).  "args"
 * must have the following fields:
 *
 *	func		asynchronous function to invoke on each input value
 *
 *	inputs		array of input values
 */
function forEachParallel(args, callback)
{
	var func, funcs;

	func = args['func'];
	funcs = args['inputs'].map(function (input) {
		return (function (subcallback) {
			return (func(input, subcallback));
		});
	});

	return (parallel({ 'funcs': funcs }, callback));
}

/*
 * Like parallel, but invokes functions in sequence rather than in parallel
 * and aborts if any function exits with failure.  Arguments include:
 *
 *    funcs	invoke the functions in parallel
 *
 *    arg	first argument to each pipeline function
 */
function pipeline(args, callback)
{
	var funcs, uarg, rv, next;

	funcs = args['funcs'];
	uarg = args['arg'];

	rv = {
	    'operations': funcs.map(function (func) {
		return ({ 'func': func, 'status': 'waiting' });
	    }),
	    'ndone': 0,
	    'nerrors': 0
	};

	if (funcs.length === 0) {
		process.nextTick(function () { callback(null, rv); });
		return (rv);
	}

	next = function (err, result) {
		var entry = rv['operations'][rv['ndone']++];

		mod_assert.equal(entry['status'], 'pending');

		entry['status'] = err ? 'fail' : 'ok';
		entry['err'] = err;
		entry['result'] = result;

		if (err)
			rv['nerrors']++;

		if (err || rv['ndone'] == funcs.length) {
			callback(err, rv);
		} else {
			var nextent = rv['operations'][rv['ndone']];
			nextent['status'] = 'pending';

			/*
			 * We invoke the next function on the next tick so that
			 * the caller (stage N) need not worry about the case
			 * that the next stage (stage N + 1) runs in its own
			 * context.
			 */
			process.nextTick(function () {
				nextent['func'](uarg, next);
			});
		}
	};

	rv['operations'][0]['status'] = 'pending';
	funcs[0](uarg, next);

	return (rv);
}