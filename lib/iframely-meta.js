(function(iframely) {

    var async = require('async');
    var request = require('request');
    var imagemagick = require('imagemagick');
    var _ = require('underscore');
    var events = require('events');
    var iconv = require('iconv-lite');
    var sax = require('sax');
    var url = require('url');
    //TODO: get rid of non-native iconv
    var Iconv = require('iconv').Iconv;
    var NodeCache = require( "node-cache" );
    var defaultCache = new NodeCache( { stdTTL: 60 * 60 * 24, checkperiod: 60 * 60 * 1 } );

   /*
    * 1. Get all page meta:
    *   - og
    *   - twitter
    *   - meta links
    *       - image_src
    *       - oembed discovery
    *           - generate by static providers list if not exists
    *       - shorturl
    *       - ...
    *   - html tags
    *       - title
    *       -description
    *       - ...
    *
    * 2. Get oembed by discovery url:
    *   - parse XML to JSON
    *
    * 4. getImageMetadata.
    *   - mime type
    *   - width
    *   - height
    *
    * 5. Configurable caching for loaded data.
    *
    * */

    /**
     *
     */
    iframely.setCachingCallbacks = function(setCallback, getCallback) {
        cache.set = setCallback;
        cache.get = getCallback;
    };

   /**
    * @public
    * Fetches page data by uri.
    * @param {String} uri The page uri.
    * @param {Object} [options] Options.
    * @param {Boolean} [options.oembed] True if need load page oEmbed. Default: true.
    * @param {Boolean} [options.fullResponse] True if need load full page response. Default: true.
    * @param {Function} callback Completion callback function. Runs when all required data fetched. The callback gets two arguments (error, data) where data is:
    *  - data.meta - page meta and oembed merged (if oembed was requested)
    *  - data.fullResponse - string with page content
    * */
    iframely.getPageData = function(uri, options, callback) {

        if (typeof options === 'function') {
            callback = options;
            options = {};
        }

        options = options || {};

        var needFullResponse = options.fullResponse !== false;
        var needOembed = options.oembed !== false;

        var metaGotFromCache = false;
        var oembedGotFromCache = false;
        var fullResponseGotFromCache = false;

        var data = {};
        var finished = false;

        function finish(error) {

            if (finished) {
                return;
            }

            if (error) {
                finished = true;
                return callback(error);
            }

            if (data.meta && (!needFullResponse || data.fullResponse) && (!needOembed || data.oembed)) {

                finished = true;

                if (!fullResponseGotFromCache && data.meta && data.meta.charset && data.fullResponse) {
                    var charset = getCharset(data.meta.charset, true);
                    data.fullResponse = encodeText(charset, data.fullResponse);
                }

                if (!metaGotFromCache)
                    cache.set("meta:" + uri, data.meta);
                if (!oembedGotFromCache && data.oembed)
                    cache.set("oembed:" + uri, data.oembed);
                if (!fullResponseGotFromCache && data.fullResponse)
                    cache.set("fullResponse:" + uri, data.fullResponse);

                if (options._debugCache) {
                    data._debugCache = {
                        metaGotFromCache: metaGotFromCache,
                        oembedGotFromCache: oembedGotFromCache,
                        fullResponseGotFromCache: fullResponseGotFromCache
                    }
                }

                callback(error, data);
            }
        }

        async.waterfall([

            function(cb) {
                async.parallel({
                    meta: function(cb) {
                        cache.get("meta:" + uri, cb);
                    },
                    oembed: function(cb) {
                        if (needOembed) {
                            cache.get("oembed:" + uri, cb)
                        } else {
                            cb();
                        }
                    },
                    fullResponse: function(cb) {
                        if (needFullResponse) {
                            cache.get("fullResponse:" + uri, cb)
                        } else {
                            cb();
                        }
                    }
                }, cb);
            },

            function(cachedData) {

                if (cachedData.meta) {
                    metaGotFromCache = true;
                    data.meta = cachedData.meta;
                }

                if (cachedData.oembed) {
                    oembedGotFromCache = true;
                    data.oembed = cachedData.oembed;
                }

                if (cachedData.fullResponse) {
                    fullResponseGotFromCache = true;
                    data.fullResponse = cachedData.fullResponse;
                }

                // Try finish if all data present.
                finish();

                if (finished) {
                    return;
                }

                if (data.meta && !data.oembed && needOembed && (!needFullResponse || data.fullResponse)) {
                    // Do not load URI if only oembed required.

                    async.waterfall([

                        function(cb) {
                            // Filter oembed from meta.
                            var oembedLinks = findOembedLinks(uri, data.meta);

                            // Optional load oembed if cache present.
                            if (oembedLinks) {
                                getOembed(oembedLinks[0].href, cb);
                            } else {
                                cb(null, null);
                            }
                        },

                        function(oEmbed, cb) {
                            data.oembed = oEmbed || {};

                            cb();
                        }

                    ], function(error) {
                        finish(error);
                    });

                } else {
                    // Usual workflow.

                    getUrl(uri, {
                        maxRedirects: 3,
                        fullResponse: needFullResponse && !data.fullResponse // Optional load fullResponse if cache present.
                    })
                        .on('response', function(res) {
                            if (res.statusCode == 200) {

                                if (res.headers && /text\/html/gi.test(res.headers['content-type'])) {
                                    res.pause();

                                    async.waterfall([

                                        function(cb) {
                                            // Optional load meta if cache present.
                                            if (data.meta) {
                                                cb(null, data.meta);
                                            } else {
                                                var saxStream = sax.createStream(false);
                                                saxStream.contentType = res.headers['content-type'];
                                                parseMetaData(uri, saxStream, cb);
                                                res.setEncoding('binary');
                                                res.pipe(saxStream);
                                                res.resume();
                                            }
                                        },

                                        function(meta, cb) {
                                            data.meta = meta;

                                            // Filter oembed from meta.
                                            var oembedLinks = needOembed && findOembedLinks(uri, data.meta);

                                            // Optional load oembed if cache present.
                                            if (oembedLinks && !data.oembed) {
                                                getOembed(oembedLinks[0].href, function(error, oembed) {
                                                    if (error === 404) {
                                                        console.error("404 on oembed", oembedLinks[0].href);
                                                    }
                                                    cb(null, oembed);
                                                });
                                            } else {
                                                cb(null, null);
                                            }
                                        },

                                        function(oEmbed, cb) {
                                            if (needOembed) {
                                                data.oembed = oEmbed || {};
                                            }

                                            cb();
                                        }

                                    ], function(error) {
                                        finish(error);
                                    });

                                } else {
                                    finished = true;
                                    processNonHtmlResponse(uri, res, callback);
                                }
                            } else {
                                callback(res.statusCode);
                            }
                        })
                        .on('complete', function(body) {
                            // TODO: always store in cache. If another request in time of loading this - wait first to finish and load from cache.
                            data.fullResponse = body;
                            finish();
                        })
                        .on('error', function(error) {
                            finish(error);
                        });
                }
            }
        ]);
    };

   /**
    * @public
    * Get image size and type.
    * @param {String} uri Image uri.
    * @param {Function} callback Completion callback function. The callback gets two arguments (error, result) where result has:
    *  - result.format
    *  - result.width
    *  - result.height
    *
    *  error == 404 if not found.
    * */
    iframely.getImageMetadata = function(uri, callback){

        withCache("image:" + uri, function(cb) {

            async.waterfall([
                function(cb){
                    getFirstBytes(uri, 30000, 5, cb);
                },
                function(buf, cb){
                    if (!buf)
                        return cb(null,null);

                    imagemagick.identify({data: buf}, cb);
                }
            ], function(error, data) {
                if (error) {
                    if (error.code == "ENOTFOUND"
                        || error == 500
                        || error == 404) {
                        return cb(null, {error: 404});
                    }

                    if (error.code == 1) {
                        return cb(null, {error: error.message});
                    }
                }

                cb(error, data);
            });

        }, callback);
    };

    //====================================================================================
    // Private
    //====================================================================================

    /**
     * @private
     * retrieve first @numBytes of URI
     */
    function getFirstBytes(uri, numBytes, maxRedirects, callback){
        var responded;

        function _callback(){
            if (!responded){
                responded = true;
                callback.apply(this, arguments);
            }
        }

        try {
            var r = request({
                uri: uri,
                method: 'GET',
                headers: {
                    'User-Agent': 'iframe.ly',
                    'Range': 'bytes=0-'+numBytes
                },
                maxRedirects: maxRedirects,
                jar: request.jar()   //Enable cookies, uses new jar
            });

            r.on('error', function(error) {
                _callback(error);
            })
                .on('response', function(res) {
                    if ((res.statusCode == 200) || (res.statusCode == 206)){
                        res.setEncoding('binary');

                        var buffer = [];
                        var bodyLen = 0;

                        var end = function(){
                            var body;

                            if (buffer.length && Buffer.isBuffer(buffer[0])) {
                                body = new Buffer(bodyLen);
                                var i = 0;
                                buffer.forEach(function (chunk) {
                                    chunk.copy(body, i, 0, chunk.length);
                                    i += chunk.length
                                });
                            } else if (buffer.length) {
                                body = new Buffer(buffer.join(''),'binary');
                            }

                            _callback(null, body);
                        };

                        res.on("data", function (chunk) {
                            if (!end) {
                                return;
                            }
                            buffer.push(chunk);
                            bodyLen += chunk.length;

                            if (bodyLen > numBytes){
                                r.abort();
                                end();
                                end = null;
                            }
                        });
                        res.on("end", function () {
                            end && end();
                        })

                    } else {
                        _callback(res.statusCode);
                    }
                });
        } catch (ex) {
            console.error('Error on getFirstBytes for', uri, '.\n Error:' + ex);
            callback(ex);
        }
    }

    /**
     * @private
     * Convert XML or JSON stream to an oEmbed object.
     */
    function stream2oembed(stream, callback) {
        stream.headers['content-type'].match('xml') ?
            xmlStream2oembed(stream, callback) :
            jsonStream2oembed(stream, callback);
    }

    /**
     * @private
     * Do HTTP GET request and handle redirects
     * @param url Request uri (parsed object or string)
     * @param {Object} options
     * @param {Number} [options.maxRedirects]
     * @param {Boolean} [options.fullResponse] True if need load full page response. Default: false.
     * @param {Function} [callback] The completion callback function or events.EventEmitter object
     * @returns {events.EventEmitter} The emitter object which emit error or response event
     */
    function getUrl(url, options, callback) {

        var req = new events.EventEmitter();

        if (typeof callback === 'function') {
            req.on('response', function(res) {
                callback(null, res);
            });
            req.on('error', function(error) {
                callback(error);
            });
        }

        try {
            request({
                uri: url,
                method: 'GET',
                headers: {'User-Agent': 'iframe.ly'},
                maxRedirects: options.maxRedirects,
                callback: (callback || options.fullResponse) ? function() {} : undefined,
                jar: request.jar()   //Y helo thar garbage collector
            })
                .on('error', function(error) {
                    req.emit('error', error);
                })
                .on('response', function(res) {
                    req.emit('response', res);
                })
                .on('complete', function(res, body) {
                    req.emit('complete', body);
                });
        } catch (ex) {
            console.error('Error on getUrl for', uri, '.\n Error:' + ex);
            callback(ex);
        }
        return req;
    }

    var utf8_iso8859_1 = new Iconv('UTF-8', 'ISO8859-1//IGNORE');

    /**
     * @private
     */
    function encodeText(charset, text) {
        try {
            var decoded = utf8_iso8859_1.convert(text);

            if (charset) {
                return charset.iconv.convert(decoded).toString();

            } else {
                return decoded.toString();
            }
        } catch(e) {
            return text;
        }
    }

    /**
     * @private
     */
    function getCharset(string, doNotParse) {
        var charset;

        if (doNotParse) {
            charset = string.toUpperCase();
        } else {
            var m = string && string.match(/charset=([\w-]+)/i);
            charset = m && m[1].toUpperCase();
        }

        if (charset && charset === 'UTF-8')
            charset = null;

        if (charset) {
            return {
                charset: charset,
                iconv: new Iconv(charset, 'UTF-8')
            };
        }

        return null;
    }

    /**
     * @private
     * Convert XML stream to an oembed object
     */
    function xmlStream2oembed(stream, callback) {
        var oembed;
        var prop;
        var value;
        var firstTag;

        var charset = getCharset(stream.headers && stream.headers['content-type']);

        var saxStream = sax.createStream();
        saxStream.on('error', function(err) {
            callback(err);
        });
        saxStream.on('opentag', function(tag) {
            if (!firstTag) {
                // Should be HEAD but HASH tag found on qik.
                firstTag = tag.name;
                oembed = {};
            } else if (oembed) {
                prop = tag.name.toLowerCase();
                value = "";
            }
        });
        saxStream.on('text', function(text) {
            if (prop) value += encodeText(charset, text);
        });
        saxStream.on('cdata', function(text) {
            if (prop) value += encodeText(charset, text);
        });
        saxStream.on('closetag', function(name) {
            if (name === firstTag) {
                callback(null, oembed);

            } else {
                if (prop) {
                    if (prop.match(/(width|height)$/))
                        value = parseInt(value);

                    oembed[prop] = value;
                }
                prop = null;
            }
        });

        stream.pipe(saxStream);
    }

    /**
     * @private
     * Convert JSON stream to an oembed object
     */
    function jsonStream2oembed(stream, callback) {

        var charset = getCharset(stream.headers && stream.headers['content-type']);

        var data = "";
        stream.on('data', function(chunk) {
            data += chunk;

        }).on('end', function() {
                try {
                    data = JSON.parse(encodeText(charset, data));
                } catch (e) {
                    callback(e);
                    return;
                }

                for(var prop in data) {
                    if (prop.match(/(width|height)$/)) {
                        data[prop] = parseInt(data[prop]);
                    }
                }

                callback(null, data);
            });
    }

    var LINK_REL_SKIP_VALUES = [
        'help',
        'license',
        'next',
        'prefetch',
        'prev',
        'search',
        'stylesheet'
    ];

    var LINK_REL_ARRAY_VALUES = [
        'alternate'
    ];

    /**
     * @private
     * Parse Open Graph meta on page
     */
    function parseMetaData(uri, saxStream, callback) {

        var charset = getCharset(saxStream.contentType);

        var result = {};

        var currentCustomTag;
        var customProperties = {};

        function _merge(parentObj, props, value) {
            function _buildChildren(children, obj) {
                var current = obj;
                children.forEach(function(child){
                    if (typeof(current[child]) != 'object') {
                        if(typeof(current[child]) == 'undefined') {
                            current[child] = {};
                        } else {
                            if (child == 'audio' || child == 'image' || child == 'video') {
                                current[child] = {
                                    url: current[child]
                                }
                            } else {
                                current[child] = {
                                    value: current[child]
                                }
                            }
                        }
                    }
                    current = current[child];
                });
                return current;
            }

            var currentNode = props.slice(-1)[0];

            if (typeof(currentNode) == 'undefined'){
                return;
            }

            var parentNode = _buildChildren(props.slice(0,-1),parentObj);

            if (!(currentNode in parentNode)) {
                parentNode[currentNode] = value;

            } else if (_.isArray(parentNode[currentNode])) {
                parentNode[currentNode].push(value);

            } else {
                if (parentNode[currentNode] != value){
                    parentNode[currentNode] = [parentNode[currentNode], value];
                }
            }
        }

        function _finalMerge() {
            for(var name in customProperties) {
                if (!(name in result)) {
                    result[name] = customProperties[name];
                }
            }

            function encodeAllStrings(obj) {
                for (var k in obj)
                {
                    if (typeof obj[k] == "object")
                        encodeAllStrings(obj[k]);
                    else {
                        if (!obj.hasOwnProperty(k))
                            continue;       // skip this property
                        if (typeof(obj[k]) == 'string'){
                            obj[k] = encodeText(charset, obj[k]);
                        }

                    }
                }
            }

            //This is the "to-the-forehead" solution for those glitchy situations.
            function processArrays(obj){
                for (var k in obj) {
                    if (!obj.hasOwnProperty(k)){
                        continue;
                    } else if (obj[k] instanceof Array){
                        if ((obj[k].length == 2) && (typeof(obj[k][0]) == 'object') && ((typeof(obj[k][1])!='undefined') && (typeof(obj[k][1])!='object'))){
                            obj[k][0][(k == 'audio' || k == 'image' || k == 'video') ? 'url' : 'value'] = obj[k][1];
                            obj[k] = obj[k][0];
                        }
                    } else if (typeof obj[k] == "object"){
                        processArrays(obj[k]);
                    }
                }
            }

            encodeAllStrings(result);
            processArrays(result);

            result['charset'] = charset ? charset.charset : 'UTF-8';
        }

        var end = false;
        saxStream.on('error', function(err) {
            if (end) return;

            console.error('sax error', err);
            callback(err);
            end = true;
        });
        saxStream.on('opentag', function(tag) {
            if (end) return;

            if (tag.name === 'META') {
                var metaTag = tag.attributes;

                if (('property' in metaTag) || ('name' in metaTag)) {

                    var propertyParts = ('property' in metaTag) ? metaTag.property.split(':') : metaTag.name.split(':');

                    var value = metaTag.content || metaTag.value;

                    if (typeof(value) == 'string') {
                        value = value.replace(/(\r\n|\n|\r)/gm,"");
                    }

                    if (/^\d+$/.test(value)) { // convert to integer
                        value = parseInt(value);
                    }

                    _merge(result, propertyParts, value);

                } else if (metaTag['http-equiv'] && metaTag['http-equiv'].toLowerCase() == 'content-type') {
                    // Override encoding with <meta content='text/html; charset=UTF-8' http-equiv='Content-Type'/>
                    charset = getCharset(metaTag.content);
                } else if (metaTag['charset']) {
                    // Override encoding with <meta charset="UTF-8" />.
                    charset = getCharset(metaTag['charset'], true);
                } else if (metaTag['http-equiv'] && metaTag['http-equiv'].toLowerCase() == 'x-frame-options') {
                    customProperties["x-frame-options"] = metaTag.content;
                } else if (metaTag.name == "description") {
                    customProperties["html-description"] = metaTag.content;
                }

            } else if (tag.name == 'TITLE') {
                currentCustomTag = {
                    name: "html-title",
                    value: ""
                };
            } else if (tag.name == 'LINK') {
                var metaTag = tag.attributes || {};
                var rel = metaTag.rel;
                var sizes = metaTag.sizes;
                var type = metaTag.type;
                var href;
                if (typeof(metaTag.href) == 'string') {
                    href = metaTag.href.replace(/(\r\n|\n|\r)/gm,"");
                    href = url.resolve(uri, href);
                }

                if (LINK_REL_SKIP_VALUES.indexOf(rel) == -1) {
                    var existingProperty = customProperties[rel];

                    if (existingProperty && !(existingProperty instanceof Array)) {
                        existingProperty = customProperties[rel] = [existingProperty];
                    }

                    if (!existingProperty && LINK_REL_ARRAY_VALUES.indexOf(rel) > -1) {
                        existingProperty = customProperties[rel] = [];
                    }

                    var property;
                    if (type || sizes) {
                        property = {
                            href: href
                        };
                        if (type) {
                            property.type = type;
                        }
                        if (sizes) {
                            property.sizes = sizes;
                        }
                    } else {
                        property = href;
                    }

                    if (existingProperty) {
                        existingProperty.push(property);
                    } else {
                        customProperties[rel] = property;
                    }
                }
            }
        });
        saxStream.on('text', function(text) {
            if (currentCustomTag) {
                currentCustomTag.value = text;
            }
        });
        saxStream.on('closetag', function(name) {
            if (end) return;

            if (currentCustomTag) {
                customProperties[currentCustomTag.name] = currentCustomTag.value;
                currentCustomTag = null;
            }

            if (name === 'HEAD') {
                _finalMerge();
                callback(null, result);
                end = true;
            }
        });
        saxStream.on('end', function() {
            if (end) return;

            _finalMerge();
            callback(null, result);
            end = true;
        });
    }

    function processNonHtmlResponse(uri, res, callback){
        var headers = _.pick(res.headers || {}, 'last-modified','content-type', 'content-length', 'content-disposition', 'expires', 'cache-control');
        var filename;

        if (headers['content-disposition']){
            //RFC2231 parsing
            var cdheader = mimelib.parseHeaderLine(mimelib.parseMimeWords(headers['content-disposition']));

            if (cdheader['filename*']){
                //TODO: test this! I cannot find a public URL that uses filename*
                var nameparts = cdheader['filename*'].replace( /^"+|"+$/g, '').split('\'');
                var encoding, encodedname;
                if (nameparts.length == 1){
                    encodedname = nameparts[0];
                } else if (nameparts.length == 3) {
                    encoding = nameparts[0].replace(/^\s+|\s+$/g, '');
                    encodedname = nameparts[2];
                }

                if (encodedname){
                    filename = iconv.decode(decodeURIComponent(encodedname), encoding || 'utf8');
                }
            }

            if (!filename && cdheader['filename']){
                //Already processed by mimelib, needs only to remove optional quotes
                filename = cdheader['filename'].replace( /^"+|"+$/g, '');
            }

        }

        if (!filename){
            var m = uri.match(/\/([^\/\?&#]+\.[%\w\-]+)$/);
            if (m){
                filename = m[1];
            }
        }

        callback({error: 'invalid-content-type', url:uri, headers: headers, filename:filename});
    }

    /**
     * @private
     * Get the oembed uri via known providers
     * @param {String} uri The page uri
     * @return {String} The oembed uri
     */
    function lookupStaticProviders(uri) {
        var providers = require('../../iframely-node2/providers.json');

        var protocolMatch = uri.match(/^(https?:\/\/)/);
        var uri2 = uri.substr(protocolMatch[1].length);

        var links;

        for (var j = 0; j < providers.length; j++) {
            var p = providers[j];
            var match;
            for (var i = 0; i < p.templates.length; i++) {
                match = uri2.match(p.templates[i]);
                if (match) break;
            }

            if (match) {
                var endpoint = p.endpoint;
                if (endpoint.match(/\{1\}/)) {
                    endpoint = endpoint.replace(/\{1\}/, match[1]);

                } else if (endpoint.match(/\{url\}/)) {
                    endpoint = endpoint.replace(/\{url\}/, encodeURIComponent(uri))

                } else {
                    endpoint = endpoint + '?url=' + encodeURIComponent(uri)
                }

                links = ['json', 'xml'].map(function(format) {
                    return {
                        href: endpoint.match(/\{format\}/)? endpoint.replace(/\{format\}/, format): endpoint + '&format=' + format,
                        rel: 'alternate',
                        type: 'application/' + format + '+oembed'
                    }
                });
                break;
            }
        }

        return links;
    }

    function findOembedLinks(uri, meta) {
        // Filter oembed from meta.
        var oembedLinks = meta.alternate && meta.alternate.filter(function(link) {
            return /^(application|text)\/(xml|json)\+oembed$/i.test(link.type);
        });

        if (!oembedLinks || !oembedLinks.length) {
            // Find oembed in static providers list.
            oembedLinks = lookupStaticProviders(uri);

            if (oembedLinks) {
                // Merge found links to meta.
                meta.alternate = (meta.alternate || []).concat(oembedLinks);
            }
        }

        return oembedLinks;
    }

    /**
     * @private
     * Fetches and parses oEmbed by oEmbed URL got from discovery.
     * @param {String} uri Full oEmbed endpoint plus URL and any needed format parameter.
     * @param {Function} callback Completion callback function. The callback gets two arguments (error, oembed) where oembed is json parsed oEmbed object.
     * */
    function getOembed(uri, callback) {

        getUrl(uri, {
            maxRedirects: 3
        }, function(error, res) {

            if (error) {
                return callback(error);
            }

            if (res.statusCode == 200) {

                res.setEncoding('binary');

                stream2oembed(res, callback);

            } else {
                callback(res.statusCode);
            }

        });
    };

    var cache = {
        set: function(key, data) {
            defaultCache.set(key, data);
        },
        get: function(key, cb) {
            defaultCache.get(key, function(error, data) {
                if (error) {
                    return cb(error, null);
                }

                if (data && key in data) {
                    cb(null, data[key]);
                } else {
                    cb(null, null);
                }
            });
        }
    };

    /**
     * @private
     */
    function withCache(key, func, callback) {

        cache.get(key, function(error, data) {

            if (!error && data) {

                callback(null, data);

            } else {

                func(function(error, data) {
                    if (error) {
                        callback(error);

                    } else {
                        cache.set(key, data);
                        callback(error, data);
                    }
                });
            }
        });
    }

})(exports);