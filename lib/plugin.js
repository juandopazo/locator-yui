/*
 * Copyright (c) 2013, Yahoo! Inc.  All rights reserved.
 * Copyrights licensed under the New BSD License.
 * See the accompanying LICENSE file for terms.
 */

/*jslint node: true, nomen: true */

"use strict";

var libpath = require('path'),
    utils = require('./utils'),
    shifter = require('./shifter'),
    BuilderClass = require('./builder'),
    debug = require('debug')('locator:yui'),
    description = require('../package.json').description;

/**
`locator-yui` plugin builds and registers yui modules and metadata from the
bundle by `locator`.

Here is an example:

    var Locator = require('locator'),
        LocatorYUI = require('locator-yui'),
        loc;

    loc = new Locator({ buildDirectory: __dirname });
    loc.plug(new LocatorYUI({ // options here // })).parseBundle(__dirname);

Here is another example with custom settings:

    loc.plug(new LocatorYUI({
        lint: true,
        coverage: true,
        silence: false
        })
        .parseBundle(__dirname);

@class plugin
@static
@uses *path, utils, shifter, builder, *debug
@extensionfor yui
*/

/**
Creates a locator plugin that can analyze locator bundles, build modules
and build loader metadata for all yui modules within the bundle.

@constructor
@static
@param {Object} config Optional plugin configuration
objects that, if passed, will be mix with the default
configuration of the plugin.

    @param {Boolean} config.cache Whether or not the shifting process should be cached
        to speed up the build process. By default, it is true.
    @param {object} config.args Optional custom shifter cli arguments. This will overrule
        custom `options` that are translated into shifter arguments.
    @param {Boolean} config.lint Optional enable linting in shifter.
    @param {Boolean} config.coverage Optional generate `-coverage.js` version of modules in shifter.
    @param {Boolean} config.silent Optional run shifter in silent mode.
    @param {Boolean} config.quiet Optional run shifter in quiet mode.
    @param {String} config.cssproc Optional loader `base` value to preprocess css to readjust urls
        for assets to resolve with `base` for the corresponding bundle build directory to make them
        work with combo.
    @param {RegExp|Function} config.filter optional regex or function to execute
        for each `evt.files`. If no `filter` is supplied, all modified files will be
        shifted. If the regex is provided, it will be tested against every
        `evt.files`, testing the relative path to determine if the file should be
        shifted or not. In a function if provided, the function will be called for
        every `evt.files` with the following arguments:
        @param {Object} filter.bundle the current bundle to where the file belongs to
        @param {Object} filter.relativePath the relative path to the file from the bundle
        @param {boolean} filter.return Return true to indicate that the
        file should be shifted. Otherwise the file will be skipped.
**/
function PluginClass(config) {

    var args = ['--no-global-config'],
        regexFilter;

    config = config || {};

    // enable cache by default
    if (!config.hasOwnProperty('cache')) {
        config.cache = true;
    }

    if (config.filter && utils.isRegExp(config.filter)) {
        // adding support for a regex instead of a functions
        regexFilter = config.filter;
        config.filter = function (bundle, relativePath) {
            return regexFilter.test(relativePath);
        };
    }

    if (!config.coverage) {
        args.push('--no-coverage');
    }
    if (!config.lint) {
        args.push('--no-lint');
    }
    // if not debug, then let's make shifter to run in silence mode
    if (!utils.debugMode || config.silent) {
        debug('running shifter in silent mode');
        args.push('--silent');
    }
    // if not debug, then let's make shifter to run in quiet mode
    if (!utils.debugMode || config.quiet) {
        debug('running shifter in quiet mode');
        args.push('--quiet');
    }

    this.describe = {
        summary: description,
        types: ['*'],
        args: args.concat(config.args || []),
        options: config
    };

    debug('computed arguments for shifter: %s', this.describe.args.join(' '));

    // internal cache structure
    this._bundles = {};
}

PluginClass.prototype = {

    /**
    Registers information about modules that will be used
    to generate the bundle meta.

    @method register
    @protected
    @param {string} bundleName The bundle name to be registered.
    @param {string} cacheKey The cache key for the file that generates mod.
    @param {Object} mod The module information generated by the shifter module.
    **/
    _register: function (bundleName, cacheKey, mod) {
        this._bundles[bundleName] = this._bundles[bundleName] || {};
        this._bundles[bundleName][cacheKey] = mod;
    },

    /**
    Analyze build information and generate loader meta data from it.

    @method getLoaderData
    @protected
    @param {string} bundleName The name of the bundle to be analyzed.
    @param {function} filter Optional function to filter modules.
    @param {Object} The data generated by BuilderClass, including the js version of
    the meta module, as well as the json version.
    **/
    _getLoaderData: function (bundleName, filter) {
        var meta = this._bundles[bundleName] || {},
            buildMeta = {},
            mod,
            build,
            obj;

        for (mod in meta) {
            if (meta.hasOwnProperty(mod)) {
                for (build in meta[mod].builds) {
                    if (meta[mod].builds.hasOwnProperty(build)) {
                        // if there is a filter, and the module doesn't pass it, we should discard it,
                        // this helps to distinguish by affinity or any other config
                        if (!filter || filter(meta[mod].name, meta[mod].builds[build].config || {})) {
                            buildMeta[mod] = buildMeta[mod] || {
                                name: meta[mod].name,
                                buildfile: meta[mod].buildfile,
                                builds: {}
                            };
                            buildMeta[mod].builds[build] = meta[mod].builds[build];
                        }
                    }
                }
            }
        }

        if (!Object.keys(buildMeta).length) {
            return;
        }

        // computing the meta module
        obj = new BuilderClass({
            name: 'loader-' + bundleName,
            group: bundleName
        });
        obj.compile(buildMeta);

        return (obj.data && Object.keys(obj.data.json).length) && obj.data;
    },

    /**
    @method _createServerLoaderData
    @protected
    @param {Object} bundle
    @return {Object} server loader data
    **/
    _createServerLoaderData: function (bundle) {
        var loaderData = this._getLoaderData(bundle.name, function (name, config) {
            return (config.affinity !== 'client');
        });
        return loaderData;
    },

    /**
    @method _createClientLoaderData
    @protected
    @param {Object} bundle
    @param {String} moduleName
    @return {Object}
    **/
    _createClientLoaderData: function (bundle, moduleName) {
        var bundleName = bundle.name,
            loaderData;
        // dealing with client stuff
        loaderData = this._getLoaderData(bundleName, function (name, config) {
            return (config.affinity !== 'server');
        });
        if (loaderData) {
            // adding meta module (which is synthetic at this point
            loaderData.json[moduleName] = {
                group: bundleName,
                affinity: 'client'
            };
        }
        return loaderData;
    },

    /**
    @method _attachServerLoaderData
    @protected
    @param {Object} bundle
    @param {Object} loaderData
    **/
    _attachServerLoaderData: function (bundle, loaderData) {
        if (loaderData) {
            // attaching server loader data into loader for other components to use it
            // this helps `express-yui` to use yui modules on the serve side for example
            bundle.yui = bundle.yui || {};
            bundle.yui.server = loaderData.json;
        }
    },

    /**
    @method _attachClientLoaderData
    @protected
    @param {Object} bundle
    @param {Object} api the `api` object from Locator
    @param {String} destPath fs path where to write the loader metadata file
    @param {Object} loaderData
    @return {Object} a Promise object
    **/
    _attachClientLoaderData: function (bundle, api, destPath, loaderData) {
        var bundleName = bundle.name;
        if (loaderData) {
            // attaching client loader data into loader for other components to use it
            // this helps `express-yui` to create seed urls for example
            bundle.yui = bundle.yui || {};
            bundle.yui.client = loaderData.json;
        }
        // writing meta module if needed
        return loaderData && api.writeFileInBundle(bundleName, destPath, loaderData.js);
    },

    /**
    @method _attachClientMetaData
    @protected
    @param {Object} bundle
    @param {Array} builds
    @param {String} moduleName 
    @param {String} newfile 
    **/
    _attachClientMetaData: function (bundle, builds, moduleName, newfile) {
        if (newfile) {
            // store a fullpath to the file into the bundle for 
            // other components to use it
            bundle.yui.metaModuleFullpath = newfile;
            bundle.yui.metaModuleName = moduleName;
            // adding the new meta module into the builds collection
            builds.push(newfile);
        }
    },

    /**
    @method _shiftEverything
    @protected
    @param {Object} bundle
    @param {String} cssproc
    @param {Object} builds
    @param {Object} shifter
    @param {Function} cb
    **/
    _shiftEverything: function (bundle, cssproc, builds, shifter, cb) {
        var self = this,
            args = [].concat(self.describe.args);

        // if cssproc is enabled, `base` is going to be computed and it is going to be added
        // in front of each `url()` in the css modules thru shifter.
        if (cssproc) {
            cssproc = (cssproc.charAt(cssproc.length - 1) === "/") ? cssproc : (cssproc + "/");
            args = args.concat('--cssproc', cssproc + libpath.basename(bundle.buildDirectory));
        }

        // building files for the bundle
        shifter.shiftFiles(builds, {
            buildDir: bundle.buildDirectory,
            args: args,
            cache: self.describe.options.cache
        }, cb);
    },

    bundleUpdated: function (evt, api) {

        var self = this,
            bundle = evt.bundle,
            bundleName = bundle.name,
            moduleName = 'loader-' + bundleName,
            destination_path = moduleName + '.js',
            cssproc = this.describe.options.cssproc,
            meta,
            builds,
            files;

        // getting files to be shifted
        files = utils.filterFilesInBundle(bundle, evt.files, self.describe.options.filter);

        // getting all build.json that should be shifted
        builds = this._buildsInBundle(bundle, files, api.getBundleFiles(bundleName, {
            extensions: 'json'
        }));

        meta = this._bundles[bundleName];

        if (!meta || builds.length === 0) {
            // no yui module in queue
            return;
        }


        return api.promise(function (fulfilled) {
            var loaderData = self._createServerLoaderData(bundle);
            fulfilled(loaderData);
        })
            .then(function (loaderData) {
                self._attachServerLoaderData(bundle, loaderData);
            })
            .then(function () {
                return api.promise(function (fulfilled) {
                    var loaderData = self._createClientLoaderData(bundle, moduleName);
                    fulfilled(loaderData);
                });
            })
            .then(function (loaderData) {
                return self._attachClientLoaderData(bundle, api, destination_path, loaderData);
            })
            .then(function (newfile) {
                self._attachClientMetaData(bundle, builds, moduleName, newfile);
            })
            .then(function () {
                return api.promise(function (fulfilled, rejected) {
                    self._shiftEverything(bundle, cssproc, builds, shifter, function (err) {
                        if (err) {
                            rejected(err);
                            return;
                        }
                        fulfilled();
                    });
                });
            });
    },

    /**
    Analyze modified files and build.json files to infer the list of `build.json`
    files that should be shifted.

    @method _buildsInBundle
    @protected
    @param {Object} bundle the bundle to be analyzed
    @param {array} modifiedFiles The filesystem path for all modified files in bundle.
    @param {array} jsonFiles The filesystem path for all json files in bundle.
    @return {array} The filesystem path for all files that should be shifted using shifter
    **/
    _buildsInBundle: function (bundle, modifiedFiles, jsonFiles) {
        var bundleName = bundle.name,
            file,
            dir,
            mod,
            i,
            m,
            builds = {};

        // validating and ordering the list of files to make sure they are processed
        // in the same order every time to generate the metas. If the order is not
        // preserved, your CI might generate a re-ordered meta module that might
        // invalidate cache due to the nature of the promises used in locator that
        // are async by nature.
        modifiedFiles = (modifiedFiles && modifiedFiles.sort()) || [];
        jsonFiles = (jsonFiles && jsonFiles.sort()) || [];

        // looking for modified yui modules
        for (m = 0; m < modifiedFiles.length; m += 1) {
            file = modifiedFiles[m];
            // there is not need to add loader meta module into builds collection
            if (libpath.extname(file) === '.js' && libpath.basename(file) !== 'loader-' + bundleName + '.js') {
                mod = shifter._checkYUIModule(file);
                if (mod) {
                    this._register(bundleName, file, mod);
                    builds[file] = true;
                }
            }
        }

        // looking for build.json
        for (i = 0; i < jsonFiles.length; i += 1) {
            if (libpath.basename(jsonFiles[i]) === 'build.json') {
                mod = shifter._checkBuildFile(jsonFiles[i]);
                if (mod) {
                    dir = libpath.dirname(jsonFiles[i]);
                    for (m = 0; m < modifiedFiles.length; m += 1) {
                        file = modifiedFiles[m];
                        // if build.json itself was modified, we should not skip
                        if (file === jsonFiles[i]) {
                            builds[jsonFiles[i]] = true;
                        }
                        // if there is a modified .js file in the range,
                        // and it is not under build directory,
                        // we should shift it, just in case
                        // note: this is not ideal, but we don't know how to analyze a build.json to really
                        //       know when to build it or not, so we need to build it everytime
                        if (libpath.extname(file) === '.js' &&
                                file.indexOf(dir) === 0 &&
                                file.indexOf(bundle.buildDirectory) === -1) {
                            builds[jsonFiles[i]] = true;
                        }
                    }
                    this._register(bundleName, jsonFiles[i], mod);
                }
            }
        }
        return Object.keys(builds).sort();
    }

    // getMetaModule
    // validating and ordering the list of files to make sure they are processed
    // in the same order every time to generate the metas. If the order is not
    // preserved, your CI might generate a re-ordered meta module that might
    // invalidate cache due to the nature of the promises used in locator that
    // are async by nature.

};

module.exports = PluginClass;
