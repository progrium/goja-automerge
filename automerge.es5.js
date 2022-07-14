"use strict";

var polyfill = {};

//
// text encode/decode polyfill from:
// https://github.com/samthor/fast-text-encoding
//
(function(scope) {
  'use strict';
  
  // fail early
  if (scope['TextEncoder'] && scope['TextDecoder']) {
    return false;
  }
  
  // used for FastTextDecoder
  const validUtfLabels = ['utf-8', 'utf8', 'unicode-1-1-utf-8'];
  
  /**
   * @constructor
   */
  function FastTextEncoder() {
    // This does not accept an encoding, and always uses UTF-8:
    //   https://www.w3.org/TR/encoding/#dom-textencoder
  }
  
  Object.defineProperty(FastTextEncoder.prototype, 'encoding', {value: 'utf-8'});
  
  /**
   * @param {string} string
   * @param {{stream: boolean}=} options
   * @return {!Uint8Array}
   */
  FastTextEncoder.prototype['encode'] = function(string, options={stream: false}) {
    if (options.stream) {
      throw new Error(`Failed to encode: the 'stream' option is unsupported.`);
    }
  
    let pos = 0;
    const len = string.length;
  
    let at = 0;  // output position
    let tlen = Math.max(32, len + (len >>> 1) + 7);  // 1.5x size
    let target = new Uint8Array((tlen >>> 3) << 3);  // ... but at 8 byte offset
  
    while (pos < len) {
      let value = string.charCodeAt(pos++);
      if (value >= 0xd800 && value <= 0xdbff) {
        // high surrogate
        if (pos < len) {
          const extra = string.charCodeAt(pos);
          if ((extra & 0xfc00) === 0xdc00) {
            ++pos;
            value = ((value & 0x3ff) << 10) + (extra & 0x3ff) + 0x10000;
          }
        }
        if (value >= 0xd800 && value <= 0xdbff) {
          continue;  // drop lone surrogate
        }
      }
  
      // expand the buffer if we couldn't write 4 bytes
      if (at + 4 > target.length) {
        tlen += 8;  // minimum extra
        tlen *= (1.0 + (pos / string.length) * 2);  // take 2x the remaining
        tlen = (tlen >>> 3) << 3;  // 8 byte offset
  
        const update = new Uint8Array(tlen);
        update.set(target);
        target = update;
      }
  
      if ((value & 0xffffff80) === 0) {  // 1-byte
        target[at++] = value;  // ASCII
        continue;
      } else if ((value & 0xfffff800) === 0) {  // 2-byte
        target[at++] = ((value >>>  6) & 0x1f) | 0xc0;
      } else if ((value & 0xffff0000) === 0) {  // 3-byte
        target[at++] = ((value >>> 12) & 0x0f) | 0xe0;
        target[at++] = ((value >>>  6) & 0x3f) | 0x80;
      } else if ((value & 0xffe00000) === 0) {  // 4-byte
        target[at++] = ((value >>> 18) & 0x07) | 0xf0;
        target[at++] = ((value >>> 12) & 0x3f) | 0x80;
        target[at++] = ((value >>>  6) & 0x3f) | 0x80;
      } else {
        continue;  // out of range
      }
  
      target[at++] = (value & 0x3f) | 0x80;
    }
  
    // Use subarray if slice isn't supported (IE11). This will use more memory
    // because the original array still exists.
    return target.slice ? target.slice(0, at) : target.subarray(0, at);
  }
  
  /**
   * @constructor
   * @param {string=} utfLabel
   * @param {{fatal: boolean}=} options
   */
  function FastTextDecoder(utfLabel='utf-8', options={fatal: false}) {
    if (validUtfLabels.indexOf(utfLabel.toLowerCase()) === -1) {
      throw new RangeError(
        `Failed to construct 'TextDecoder': The encoding label provided ('${utfLabel}') is invalid.`);
    }
    if (options.fatal) {
      throw new Error(`Failed to construct 'TextDecoder': the 'fatal' option is unsupported.`);
    }
  }
  
  Object.defineProperty(FastTextDecoder.prototype, 'encoding', {value: 'utf-8'});
  
  Object.defineProperty(FastTextDecoder.prototype, 'fatal', {value: false});
  
  Object.defineProperty(FastTextDecoder.prototype, 'ignoreBOM', {value: false});
  
  /**
   * @param {!Uint8Array} bytes
   * @return {string}
   */
  function decodeBuffer(bytes) {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf-8');
  }
  
  /**
   * @param {!Uint8Array} bytes
   * @return {string}
   */
  function decodeSyncXHR(bytes) {
    let u;
  
    // This hack will fail in non-Edgium Edge because sync XHRs are disabled (and
    // possibly in other places), so ensure there's a fallback call.
    try {
      const b = new Blob([bytes], {type: 'text/plain;charset=UTF-8'});
      u = URL.createObjectURL(b);
  
      const x = new XMLHttpRequest();
      x.open('GET', u, false);
      x.send();
      return x.responseText;
    } catch (e) {
      return decodeFallback(bytes);
    } finally {
      if (u) {
        URL.revokeObjectURL(u);
      }
    }
  }
  
  /**
   * @param {!Uint8Array} bytes
   * @return {string}
   */
  function decodeFallback(bytes) {
    let inputIndex = 0;
  
    // Create a working buffer for UTF-16 code points, but don't generate one
    // which is too large for small input sizes. UTF-8 to UCS-16 conversion is
    // going to be at most 1:1, if all code points are ASCII. The other extreme
    // is 4-byte UTF-8, which results in two UCS-16 points, but this is still 50%
    // fewer entries in the output.
    const pendingSize = Math.min(256 * 256, bytes.length + 1);
    const pending = new Uint16Array(pendingSize);
    const chunks = [];
    let pendingIndex = 0;
  
    for (;;) {
      const more = inputIndex < bytes.length;
  
      // If there's no more data or there'd be no room for two UTF-16 values,
      // create a chunk. This isn't done at the end by simply slicing the data
      // into equal sized chunks as we might hit a surrogate pair.
      if (!more || (pendingIndex >= pendingSize - 1)) {
        // nb. .apply and friends are *really slow*. Low-hanging fruit is to
        // expand this to literally pass pending[0], pending[1], ... etc, but
        // the output code expands pretty fast in this case.
        chunks.push(String.fromCharCode.apply(null, pending.subarray(0, pendingIndex)));
  
        if (!more) {
          return chunks.join('');
        }
  
        // Move the buffer forward and create another chunk.
        bytes = bytes.subarray(inputIndex);
        inputIndex = 0;
        pendingIndex = 0;
      }
  
      // The native TextDecoder will generate "REPLACEMENT CHARACTER" where the
      // input data is invalid. Here, we blindly parse the data even if it's
      // wrong: e.g., if a 3-byte sequence doesn't have two valid continuations.
  
      const byte1 = bytes[inputIndex++];
      if ((byte1 & 0x80) === 0) {  // 1-byte or null
        pending[pendingIndex++] = byte1;
      } else if ((byte1 & 0xe0) === 0xc0) {  // 2-byte
        const byte2 = bytes[inputIndex++] & 0x3f;
        pending[pendingIndex++] = ((byte1 & 0x1f) << 6) | byte2;
      } else if ((byte1 & 0xf0) === 0xe0) {  // 3-byte
        const byte2 = bytes[inputIndex++] & 0x3f;
        const byte3 = bytes[inputIndex++] & 0x3f;
        pending[pendingIndex++] = ((byte1 & 0x1f) << 12) | (byte2 << 6) | byte3;
      } else if ((byte1 & 0xf8) === 0xf0) {  // 4-byte
        const byte2 = bytes[inputIndex++] & 0x3f;
        const byte3 = bytes[inputIndex++] & 0x3f;
        const byte4 = bytes[inputIndex++] & 0x3f;
  
        // this can be > 0xffff, so possibly generate surrogates
        let codepoint = ((byte1 & 0x07) << 0x12) | (byte2 << 0x0c) | (byte3 << 0x06) | byte4;
        if (codepoint > 0xffff) {
          // codepoint &= ~0x10000;
          codepoint -= 0x10000;
          pending[pendingIndex++] = (codepoint >>> 10) & 0x3ff | 0xd800;
          codepoint = 0xdc00 | codepoint & 0x3ff;
        }
        pending[pendingIndex++] = codepoint;
      } else {
        // invalid initial byte
      }
    }
  }
  
  // Decoding a string is pretty slow, but use alternative options where possible.
  let decodeImpl = decodeFallback;
  if (typeof Buffer === 'function' && Buffer.from) {
    // Buffer.from was added in Node v5.10.0 (2015-11-17).
    decodeImpl = decodeBuffer;
  } else if (typeof Blob === 'function' && typeof URL === 'function' && typeof URL.createObjectURL === 'function') {
    // Blob and URL.createObjectURL are available from IE10, Safari 6, Chrome 19
    // (all released in 2012), Firefox 19 (2013), ...
    decodeImpl = decodeSyncXHR;
  }
  
  /**
   * @param {(!ArrayBuffer|!ArrayBufferView)} buffer
   * @param {{stream: boolean}=} options
   * @return {string}
   */
  FastTextDecoder.prototype['decode'] = function(buffer, options={stream: false}) {
    if (options['stream']) {
      throw new Error(`Failed to decode: the 'stream' option is unsupported.`);
    }
  
    let bytes;
  
    if (buffer instanceof Uint8Array) {
      // Accept Uint8Array instances as-is.
      bytes = buffer;
    } else if (buffer.buffer instanceof ArrayBuffer) {
      // Look for ArrayBufferView, which isn't a real type, but basically
      // represents all the valid TypedArray types plus DataView. They all have
      // ".buffer" as an instance of ArrayBuffer.
      bytes = new Uint8Array(buffer.buffer);
    } else {
      // The only other valid argument here is that "buffer" is an ArrayBuffer.
      // We also try to convert anything else passed to a Uint8Array, as this
      // catches anything that's array-like. Native code would throw here.
      bytes = new Uint8Array(buffer);
    }
  
    return decodeImpl(/** @type {!Uint8Array} */ (bytes));
  }
  
  scope['TextEncoder'] = FastTextEncoder;
  scope['TextDecoder'] = FastTextDecoder;
  
  }(polyfill));

//
// automerge.min.js (1.0.1-preview.7) ran through babel:
//

var _get = function get(object, property, receiver) { if (object === null) object = Function.prototype; var desc = Object.getOwnPropertyDescriptor(object, property); if (desc === undefined) { var parent = Object.getPrototypeOf(object); if (parent === null) { return undefined; } else { return get(parent, property, receiver); } } else if ("value" in desc) { return desc.value; } else { var getter = desc.get; if (getter === undefined) { return undefined; } return getter.call(receiver); } };

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

var _slicedToArray = function () { function sliceIterator(arr, i) { var _arr = []; var _n = true; var _d = false; var _e = undefined; try { for (var _i = arr[Symbol.iterator](), _s; !(_n = (_s = _i.next()).done); _n = true) { _arr.push(_s.value); if (i && _arr.length === i) break; } } catch (err) { _d = true; _e = err; } finally { try { if (!_n && _i["return"]) _i["return"](); } finally { if (_d) throw _e; } } return _arr; } return function (arr, i) { if (Array.isArray(arr)) { return arr; } else if (Symbol.iterator in Object(arr)) { return sliceIterator(arr, i); } else { throw new TypeError("Invalid attempt to destructure non-iterable instance"); } }; }();

var _typeof = typeof Symbol === "function" && typeof Symbol.iterator === "symbol" ? function (obj) { return typeof obj; } : function (obj) { return obj && typeof Symbol === "function" && obj.constructor === Symbol && obj !== Symbol.prototype ? "symbol" : typeof obj; };

function _toConsumableArray(arr) { if (Array.isArray(arr)) { for (var i = 0, arr2 = Array(arr.length); i < arr.length; i++) { arr2[i] = arr[i]; } return arr2; } else { return Array.from(arr); } }

function _possibleConstructorReturn(self, call) { if (!self) { throw new ReferenceError("this hasn't been initialised - super() hasn't been called"); } return call && (typeof call === "object" || typeof call === "function") ? call : self; }

function _inherits(subClass, superClass) { if (typeof superClass !== "function" && superClass !== null) { throw new TypeError("Super expression must either be null or a function, not " + typeof superClass); } subClass.prototype = Object.create(superClass && superClass.prototype, { constructor: { value: subClass, enumerable: false, writable: true, configurable: true } }); if (superClass) Object.setPrototypeOf ? Object.setPrototypeOf(subClass, superClass) : subClass.__proto__ = superClass; }

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

function _defineProperty(obj, key, value) { if (key in obj) { Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true }); } else { obj[key] = value; } return obj; }

/**
 * Minified by jsDelivr using Terser v5.10.0.
 * Original file: /npm/automerge@1.0.1-preview.7/dist/automerge.js
 *
 * Do NOT use SRI with dynamically generated files! More information: https://www.jsdelivr.com/using-sri-with-dynamic-files
 */
!function (e, t) {
  "object" == (typeof exports === "undefined" ? "undefined" : _typeof(exports)) && "object" == (typeof module === "undefined" ? "undefined" : _typeof(module)) ? module.exports = t() : "function" == typeof define && define.amd ? define([], t) : "object" == (typeof exports === "undefined" ? "undefined" : _typeof(exports)) ? exports.Automerge = t() : e.Automerge = t();
}(window, function () {
  return e = { "./backend/backend.js":
    /*!****************************!*\
      !*** ./backend/backend.js ***!
      \****************************/function backendBackendJs(e, t, n) {
      var _n = n( /*! ./columnar */"./backend/columnar.js"),
          s = _n.encodeChange,
          _n2 = n( /*! ./new */"./backend/new.js"),
          r = _n2.BackendDoc,
          _n3 = n( /*! ./util */"./backend/util.js"),
          o = _n3.backendState;

      function a(e, t, n) {
        if (e.hashesByActor[t] && e.hashesByActor[t][n]) return e.hashesByActor[t][n];if (!e.haveHashGraph && (e.computeHashGraph(), e.hashesByActor[t] && e.hashesByActor[t][n])) return e.hashesByActor[t][n];throw new RangeError("Unknown change: actorId = " + t + ", seq = " + (n + 1));
      }function i(e, t) {
        if (!Array.isArray(t)) throw new TypeError("Pass an array of hashes to Backend.getChanges()");return o(e).getChanges(t);
      }e.exports = { init: function init() {
          return { state: new r(), heads: [] };
        }, clone: function clone(e) {
          return { state: o(e).clone(), heads: e.heads };
        }, free: function free(e) {
          e.state = null, e.frozen = !0;
        }, applyChanges: function applyChanges(e, t) {
          var n = o(e),
              s = n.applyChanges(t);return e.frozen = !0, [{ state: n, heads: n.heads }, s];
        }, applyLocalChange: function applyLocalChange(e, t) {
          var n = o(e);if (t.seq <= n.clock[t.actor]) throw new RangeError("Change request has already been applied");if (t.seq > 1) {
            var _e = a(n, t.actor, t.seq - 2);if (!_e) throw new RangeError("Cannot find hash of localChange before seq=" + t.seq);var _s = _defineProperty({}, _e, !0);var _iteratorNormalCompletion = true;
            var _didIteratorError = false;
            var _iteratorError = undefined;

            try {
              for (var _iterator = t.deps[Symbol.iterator](), _step; !(_iteratorNormalCompletion = (_step = _iterator.next()).done); _iteratorNormalCompletion = true) {
                var _e2 = _step.value;
                _s[_e2] = !0;
              }
            } catch (err) {
              _didIteratorError = true;
              _iteratorError = err;
            } finally {
              try {
                if (!_iteratorNormalCompletion && _iterator.return) {
                  _iterator.return();
                }
              } finally {
                if (_didIteratorError) {
                  throw _iteratorError;
                }
              }
            }

            t.deps = Object.keys(_s).sort();
          }var r = s(t),
              i = n.applyChanges([r], !0);e.frozen = !0;var l = a(n, t.actor, t.seq - 1);return i.deps = i.deps.filter(function (e) {
            return e !== l;
          }), [{ state: n, heads: n.heads }, i, r];
        }, save: function save(e) {
          return o(e).save();
        }, load: function load(e) {
          var t = new r(e);return { state: t, heads: t.heads };
        }, loadChanges: function loadChanges(e, t) {
          var n = o(e);return n.applyChanges(t), e.frozen = !0, { state: n, heads: n.heads };
        }, getPatch: function getPatch(e) {
          return o(e).getPatch();
        }, getHeads: function getHeads(e) {
          return e.heads;
        }, getAllChanges: function getAllChanges(e) {
          return i(e, []);
        }, getChanges: i, getChangesAdded: function getChangesAdded(e, t) {
          return o(t).getChangesAdded(o(e));
        }, getChangeByHash: function getChangeByHash(e, t) {
          return o(e).getChangeByHash(t);
        }, getMissingDeps: function getMissingDeps(e) {
          var t = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : [];
          return o(e).getMissingDeps(t);
        } };
    }, "./backend/columnar.js":
    /*!*****************************!*\
      !*** ./backend/columnar.js ***!
      \*****************************/function backendColumnarJs(e, t, n) {
      var s = n( /*! pako */"./node_modules/pako/index.js"),
          _n4 = n( /*! ../src/common */"./src/common.js"),
          r = _n4.copyObject,
          o = _n4.parseOpId,
          a = _n4.equalBytes,
          _n5 = n( /*! ./encoding */"./backend/encoding.js"),
          i = _n5.utf8ToString,
          l = _n5.hexStringToBytes,
          c = _n5.bytesToHexString,
          d = _n5.Encoder,
          u = _n5.Decoder,
          h = _n5.RLEEncoder,
          f = _n5.RLEDecoder,
          p = _n5.DeltaEncoder,
          b = _n5.DeltaDecoder,
          g = _n5.BooleanEncoder,
          m = _n5.BooleanDecoder,
          _n6 = n( /*! fast-sha256 */"./node_modules/fast-sha256/sha256.js"),
          y = _n6.Hash,
          w = new Uint8Array([133, 111, 74, 131]),
          _ = { GROUP_CARD: 0, ACTOR_ID: 1, INT_RLE: 2, INT_DELTA: 3, BOOLEAN: 4, STRING_RLE: 5, VALUE_LEN: 6, VALUE_RAW: 7 },
          I = { NULL: 0, FALSE: 1, TRUE: 2, LEB128_UINT: 3, LEB128_INT: 4, IEEE754: 5, UTF8: 6, BYTES: 7, COUNTER: 8, TIMESTAMP: 9, MIN_UNKNOWN: 10, MAX_UNKNOWN: 15 },
          v = ["makeMap", "set", "makeList", "del", "makeText", "inc", "makeTable", "link"],
          k = [{ columnName: "objActor", columnId: 0 | _.ACTOR_ID }, { columnName: "objCtr", columnId: 0 | _.INT_RLE }, { columnName: "keyActor", columnId: 16 | _.ACTOR_ID }, { columnName: "keyCtr", columnId: 16 | _.INT_DELTA }, { columnName: "keyStr", columnId: 16 | _.STRING_RLE }, { columnName: "idActor", columnId: 32 | _.ACTOR_ID }, { columnName: "idCtr", columnId: 32 | _.INT_DELTA }, { columnName: "insert", columnId: 48 | _.BOOLEAN }, { columnName: "action", columnId: 64 | _.INT_RLE }, { columnName: "valLen", columnId: 80 | _.VALUE_LEN }, { columnName: "valRaw", columnId: 80 | _.VALUE_RAW }, { columnName: "chldActor", columnId: 96 | _.ACTOR_ID }, { columnName: "chldCtr", columnId: 96 | _.INT_DELTA }],
          x = k.concat([{ columnName: "predNum", columnId: 112 | _.GROUP_CARD }, { columnName: "predActor", columnId: 112 | _.ACTOR_ID }, { columnName: "predCtr", columnId: 112 | _.INT_DELTA }]),
          j = k.concat([{ columnName: "succNum", columnId: 128 | _.GROUP_CARD }, { columnName: "succActor", columnId: 128 | _.ACTOR_ID }, { columnName: "succCtr", columnId: 128 | _.INT_DELTA }]),
          E = [{ columnName: "actor", columnId: 0 | _.ACTOR_ID }, { columnName: "seq", columnId: 0 | _.INT_DELTA }, { columnName: "maxOp", columnId: 16 | _.INT_DELTA }, { columnName: "time", columnId: 32 | _.INT_DELTA }, { columnName: "message", columnId: 48 | _.STRING_RLE }, { columnName: "depsNum", columnId: 64 | _.GROUP_CARD }, { columnName: "depsIndex", columnId: 64 | _.INT_DELTA }, { columnName: "extraLen", columnId: 80 | _.VALUE_LEN }, { columnName: "extraRaw", columnId: 80 | _.VALUE_RAW }];function O(e, t) {
        if (!e || !e.actorId) return e;var n = e.counter,
            s = t.indexOf(e.actorId);if (s < 0) throw new RangeError("missing actorId");return { counter: n, actorNum: s, actorId: e.actorId };
      }function A(e, t) {
        return e.counter < t.counter ? -1 : e.counter > t.counter ? 1 : e.actorId < t.actorId ? -1 : e.actorId > t.actorId ? 1 : 0;
      }function R(e, t) {
        if ("_root" === e.obj) t.objActor.appendValue(null), t.objCtr.appendValue(null);else {
          if (!(e.obj.actorNum >= 0 && e.obj.counter > 0)) throw new RangeError("Unexpected objectId reference: " + JSON.stringify(e.obj));t.objActor.appendValue(e.obj.actorNum), t.objCtr.appendValue(e.obj.counter);
        }
      }function C(e, t) {
        if (e.key) t.keyActor.appendValue(null), t.keyCtr.appendValue(null), t.keyStr.appendValue(e.key);else if ("_head" === e.elemId && e.insert) t.keyActor.appendValue(null), t.keyCtr.appendValue(0), t.keyStr.appendValue(null);else {
          if (!(e.elemId && e.elemId.actorNum >= 0 && e.elemId.counter > 0)) throw new RangeError("Unexpected operation key: " + JSON.stringify(e));t.keyActor.appendValue(e.elemId.actorNum), t.keyCtr.appendValue(e.elemId.counter), t.keyStr.appendValue(null);
        }
      }function V(e, t) {
        var n = v.indexOf(e.action);if (n >= 0) t.action.appendValue(n);else {
          if ("number" != typeof e.action) throw new RangeError("Unexpected operation action: " + e.action);t.action.appendValue(e.action);
        }
      }function S(e, t) {
        if ("set" !== e.action && "inc" !== e.action || null === e.value) t.valLen.appendValue(I.NULL);else if (!1 === e.value) t.valLen.appendValue(I.FALSE);else if (!0 === e.value) t.valLen.appendValue(I.TRUE);else if ("string" == typeof e.value) {
          var _n7 = t.valRaw.appendRawString(e.value);t.valLen.appendValue(_n7 << 4 | I.UTF8);
        } else if (ArrayBuffer.isView(e.value)) {
          var _n8 = t.valRaw.appendRawBytes(new Uint8Array(e.value.buffer));t.valLen.appendValue(_n8 << 4 | I.BYTES);
        } else if ("number" == typeof e.value) {
          var _n9 = void 0,
              _ref = function (e) {
            switch (e.datatype) {case "counter":
                return [I.COUNTER, e.value];case "timestamp":
                return [I.TIMESTAMP, e.value];case "uint":
                return [I.LEB128_UINT, e.value];case "int":
                return [I.LEB128_INT, e.value];case "float64":
                {
                  var _t = new ArrayBuffer(8);return new DataView(_t).setFloat64(0, e.value, !0), [I.IEEE754, new Uint8Array(_t)];
                }default:
                if (Number.isInteger(e.value) && e.value <= Number.MAX_SAFE_INTEGER && e.value >= Number.MIN_SAFE_INTEGER) return [I.LEB128_INT, e.value];{
                  var _t2 = new ArrayBuffer(8);return new DataView(_t2).setFloat64(0, e.value, !0), [I.IEEE754, new Uint8Array(_t2)];
                }}
          }(e),
              _ref2 = _slicedToArray(_ref, 2),
              _s3 = _ref2[0],
              _r = _ref2[1];_n9 = _s3 === I.LEB128_UINT ? t.valRaw.appendUint53(_r) : _s3 === I.IEEE754 ? t.valRaw.appendRawBytes(_r) : t.valRaw.appendInt53(_r), t.valLen.appendValue(_n9 << 4 | _s3);
        } else {
          if (!("number" == typeof e.datatype && e.datatype >= I.MIN_UNKNOWN && e.datatype <= I.MAX_UNKNOWN && e.value instanceof Uint8Array)) throw e.datatype ? new RangeError("Unknown datatype " + e.datatype + " for value " + e.value) : new RangeError("Unsupported value in operation: " + e.value);{
            var _n10 = t.valRaw.appendRawBytes(e.value);t.valLen.appendValue(_n10 << 4 | e.datatype);
          }
        }
      }function N(e, t) {
        if (e === I.NULL) return { value: null };if (e === I.FALSE) return { value: !1 };if (e === I.TRUE) return { value: !0 };if (e % 16 === I.UTF8) return { value: i(t) };if (e % 16 === I.LEB128_UINT) return { value: new u(t).readUint53(), datatype: "uint" };if (e % 16 === I.LEB128_INT) return { value: new u(t).readInt53(), datatype: "int" };if (e % 16 === I.IEEE754) {
          var _e3 = new DataView(t.buffer, t.byteOffset, t.byteLength);if (8 === t.byteLength) return { value: _e3.getFloat64(0, !0), datatype: "float64" };throw new RangeError("Invalid length for floating point number: " + t.byteLength);
        }return e % 16 === I.COUNTER ? { value: new u(t).readInt53(), datatype: "counter" } : e % 16 === I.TIMESTAMP ? { value: new u(t).readInt53(), datatype: "timestamp" } : { value: t, datatype: e % 16 };
      }function T(e, t, n, s) {
        var _e$t = e[t],
            r = _e$t.columnId,
            o = _e$t.columnName,
            a = _e$t.decoder;
        if (r % 8 === _.VALUE_LEN && t + 1 < e.length && e[t + 1].columnId === r + 1) {
          var _n11 = a.readValue(),
              _r2 = e[t + 1].decoder.readRawBytes(_n11 >> 4),
              _N = N(_n11, _r2),
              _i = _N.value,
              _l = _N.datatype;return s[o] = _i, _l && (s[o + "_datatype"] = _l), 2;
        }if (r % 8 === _.ACTOR_ID) {
          var _e4 = a.readValue();if (null === _e4) s[o] = null;else {
            if (!n[_e4]) throw new RangeError("No actor index " + _e4);s[o] = n[_e4];
          }
        } else s[o] = a.readValue();return 1;
      }function U(e, t) {
        return void 0 === t ? "string" == typeof e || "boolean" == typeof e || null === e : "number" == typeof e;
      }function L(e, t, n) {
        var s = t,
            r = [];var _iteratorNormalCompletion2 = true;
        var _didIteratorError2 = false;
        var _iteratorError2 = undefined;

        try {
          for (var _iterator2 = e[Symbol.iterator](), _step2; !(_iteratorNormalCompletion2 = (_step2 = _iterator2.next()).done); _iteratorNormalCompletion2 = true) {
            var _t3 = _step2.value;
            if ("set" === _t3.action && _t3.values && _t3.insert) {
              if (0 !== _t3.pred.length) throw new RangeError("multi-insert pred must be empty");var _e5 = _t3.elemId;var _o = _t3.datatype;var _iteratorNormalCompletion3 = true;
              var _didIteratorError3 = false;
              var _iteratorError3 = undefined;

              try {
                for (var _iterator3 = _t3.values[Symbol.iterator](), _step3; !(_iteratorNormalCompletion3 = (_step3 = _iterator3.next()).done); _iteratorNormalCompletion3 = true) {
                  var _a = _step3.value;
                  if (!U(_a, _o)) throw new RangeError("Decode failed: bad value/datatype association (" + _a + "," + _o + ")");r.push({ action: "set", obj: _t3.obj, elemId: _e5, datatype: _o, value: _a, pred: [], insert: !0 }), _e5 = s + "@" + n, s += 1;
                }
              } catch (err) {
                _didIteratorError3 = true;
                _iteratorError3 = err;
              } finally {
                try {
                  if (!_iteratorNormalCompletion3 && _iterator3.return) {
                    _iterator3.return();
                  }
                } finally {
                  if (_didIteratorError3) {
                    throw _iteratorError3;
                  }
                }
              }
            } else if ("del" === _t3.action && _t3.multiOp > 1) {
              if (1 !== _t3.pred.length) throw new RangeError("multiOp deletion must have exactly one pred");var _e6 = o(_t3.elemId),
                  _n12 = o(_t3.pred[0]);for (var _o2 = 0; _o2 < _t3.multiOp; _o2++) {
                var _a2 = _e6.counter + _o2 + "@" + _e6.actorId,
                    _i2 = [_n12.counter + _o2 + "@" + _n12.actorId];r.push({ action: "del", obj: _t3.obj, elemId: _a2, pred: _i2 }), s += 1;
              }
            } else r.push(_t3), s += 1;
          }
        } catch (err) {
          _didIteratorError2 = true;
          _iteratorError2 = err;
        } finally {
          try {
            if (!_iteratorNormalCompletion2 && _iterator2.return) {
              _iterator2.return();
            }
          } finally {
            if (_didIteratorError2) {
              throw _iteratorError2;
            }
          }
        }

        return r;
      }function B(e, t) {
        var n = [];var _iteratorNormalCompletion4 = true;
        var _didIteratorError4 = false;
        var _iteratorError4 = undefined;

        try {
          for (var _iterator4 = e[Symbol.iterator](), _step4; !(_iteratorNormalCompletion4 = (_step4 = _iterator4.next()).done); _iteratorNormalCompletion4 = true) {
            var _s4 = _step4.value;
            var _e7 = null === _s4.objCtr ? "_root" : _s4.objCtr + "@" + _s4.objActor,
                _r3 = _s4.keyStr ? void 0 : 0 === _s4.keyCtr ? "_head" : _s4.keyCtr + "@" + _s4.keyActor,
                _o3 = v[_s4.action] || _s4.action,
                _a3 = _r3 ? { obj: _e7, elemId: _r3, action: _o3 } : { obj: _e7, key: _s4.keyStr, action: _o3 };if (_a3.insert = !!_s4.insert, "set" !== v[_s4.action] && "inc" !== v[_s4.action] || (_a3.value = _s4.valLen, _s4.valLen_datatype && (_a3.datatype = _s4.valLen_datatype)), !!_s4.chldCtr != !!_s4.chldActor) throw new RangeError("Mismatched child columns: " + _s4.chldCtr + " and " + _s4.chldActor);null !== _s4.chldCtr && (_a3.child = _s4.chldCtr + "@" + _s4.chldActor), t ? (_a3.id = _s4.idCtr + "@" + _s4.idActor, _a3.succ = _s4.succNum.map(function (e) {
              return e.succCtr + "@" + e.succActor;
            }), z(_s4.succNum.map(function (e) {
              return { counter: e.succCtr, actorId: e.succActor };
            }))) : (_a3.pred = _s4.predNum.map(function (e) {
              return e.predCtr + "@" + e.predActor;
            }), z(_s4.predNum.map(function (e) {
              return { counter: e.predCtr, actorId: e.predActor };
            }))), n.push(_a3);
          }
        } catch (err) {
          _didIteratorError4 = true;
          _iteratorError4 = err;
        } finally {
          try {
            if (!_iteratorNormalCompletion4 && _iterator4.return) {
              _iterator4.return();
            }
          } finally {
            if (_didIteratorError4) {
              throw _iteratorError4;
            }
          }
        }

        return n;
      }function z(e) {
        var t = null;var _iteratorNormalCompletion5 = true;
        var _didIteratorError5 = false;
        var _iteratorError5 = undefined;

        try {
          for (var _iterator5 = e[Symbol.iterator](), _step5; !(_iteratorNormalCompletion5 = (_step5 = _iterator5.next()).done); _iteratorNormalCompletion5 = true) {
            var _n13 = _step5.value;
            if (t && -1 !== A(t, _n13)) throw new RangeError("operation IDs are not in ascending order");t = _n13;
          }
        } catch (err) {
          _didIteratorError5 = true;
          _iteratorError5 = err;
        } finally {
          try {
            if (!_iteratorNormalCompletion5 && _iterator5.return) {
              _iterator5.return();
            }
          } finally {
            if (_didIteratorError5) {
              throw _iteratorError5;
            }
          }
        }
      }function D(e, t) {
        return (7 & e) === _.INT_DELTA ? new b(t) : (7 & e) === _.BOOLEAN ? new m(t) : (7 & e) === _.STRING_RLE ? new f("utf8", t) : (7 & e) === _.VALUE_RAW ? new u(t) : new f("uint", t);
      }function H(e, t) {
        var n = new Uint8Array(0);var s = [],
            r = 0,
            o = 0;for (; r < e.length || o < t.length;) {
          if (r === e.length || o < t.length && t[o].columnId < e[r].columnId) {
            var _t$o = t[o],
                _e8 = _t$o.columnId,
                _r4 = _t$o.columnName;
            s.push({ columnId: _e8, columnName: _r4, decoder: D(_e8, n) }), o++;
          } else if (o === t.length || e[r].columnId < t[o].columnId) {
            var _e$r = e[r],
                _t4 = _e$r.columnId,
                _n14 = _e$r.buffer;
            s.push({ columnId: _t4, decoder: D(_t4, _n14) }), r++;
          } else {
            var _e$r2 = e[r],
                _n15 = _e$r2.columnId,
                _a4 = _e$r2.buffer,
                _i3 = t[o].columnName;
            s.push({ columnId: _n15, columnName: _i3, decoder: D(_n15, _a4) }), r++, o++;
          }
        }return s;
      }function $(e, t, n) {
        e = H(e, n);var s = [];for (; e.some(function (e) {
          return !e.decoder.done;
        });) {
          var _n16 = {},
              _r5 = 0;for (; _r5 < e.length;) {
            var _s5 = e[_r5].columnId;var _o4 = _s5 >> 4,
                _a5 = 1;for (; _r5 + _a5 < e.length && e[_r5 + _a5].columnId >> 4 === _o4;) {
              _a5++;
            }if (_s5 % 8 === _.GROUP_CARD) {
              var _s6 = [],
                  _o5 = e[_r5].decoder.readValue();for (var _n17 = 0; _n17 < _o5; _n17++) {
                var _n18 = {};for (var _s7 = 1; _s7 < _a5; _s7++) {
                  T(e, _r5 + _s7, t, _n18);
                }_s6.push(_n18);
              }_n16[e[_r5].columnName] = _s6, _r5 += _a5;
            } else _r5 += T(e, _r5, t, _n16);
          }s.push(_n16);
        }return s;
      }function M(e) {
        var t = -9 >>> 0;var n = -1,
            s = [],
            r = e.readUint53();for (var _o6 = 0; _o6 < r; _o6++) {
          var _r6 = e.readUint53(),
              _o7 = e.readUint53();if ((_r6 & t) <= (n & t)) throw new RangeError("Columns must be in ascending order");n = _r6, s.push({ columnId: _r6, bufferLen: _o7 });
        }return s;
      }function P(e, t) {
        var n = t.filter(function (e) {
          return e.encoder.buffer.byteLength > 0;
        });e.appendUint53(n.length);var _iteratorNormalCompletion6 = true;
        var _didIteratorError6 = false;
        var _iteratorError6 = undefined;

        try {
          for (var _iterator6 = n[Symbol.iterator](), _step6; !(_iteratorNormalCompletion6 = (_step6 = _iterator6.next()).done); _iteratorNormalCompletion6 = true) {
            var _t5 = _step6.value;
            e.appendUint53(_t5.columnId), e.appendUint53(_t5.encoder.buffer.byteLength);
          }
        } catch (err) {
          _didIteratorError6 = true;
          _iteratorError6 = err;
        } finally {
          try {
            if (!_iteratorNormalCompletion6 && _iterator6.return) {
              _iterator6.return();
            }
          } finally {
            if (_didIteratorError6) {
              throw _iteratorError6;
            }
          }
        }
      }function F(e) {
        var t = e.readUint53(),
            n = [];for (var _s8 = 0; _s8 < t; _s8++) {
          n.push(c(e.readRawBytes(32)));
        }var s = { actor: e.readHexString(), seq: e.readUint53(), startOp: e.readUint53(), time: e.readInt53(), message: e.readPrefixedString(), deps: n };var r = [s.actor],
            o = e.readUint53();for (var _t6 = 0; _t6 < o; _t6++) {
          r.push(e.readHexString());
        }return s.actorIds = r, s;
      }function q(e, t) {
        var n = w.byteLength + 4 + 1 + 5,
            s = new d();s.appendRawBytes(new Uint8Array(n)), t(s);var r = s.buffer,
            o = new d();o.appendByte(e), o.appendUint53(r.byteLength - n);var a = o.buffer,
            i = new y();i.update(a), i.update(r.subarray(n));var l = i.digest(),
            c = l.subarray(0, 4);return r.set(w, n - a.byteLength - 4 - w.byteLength), r.set(c, n - a.byteLength - 4), r.set(a, n - a.byteLength), { hash: l, bytes: r.subarray(n - a.byteLength - 4 - w.byteLength) };
      }function Z(e, t) {
        if (!a(e.readRawBytes(w.byteLength), w)) throw new RangeError("Data does not begin with magic bytes 85 6f 4a 83");var n = e.readRawBytes(4),
            s = e.offset,
            r = e.readByte(),
            o = e.readUint53(),
            i = { chunkType: r, chunkLength: o, chunkData: e.readRawBytes(o) };if (t) {
          var _t7 = new y();_t7.update(e.buf.subarray(s, e.offset));var _r7 = _t7.digest();if (!a(_r7.subarray(0, 4), n)) throw new RangeError("checksum does not match data");i.hash = c(_r7);
        }return i;
      }function G(e) {
        var _ref3 = function (e, t) {
          var n = {},
              s = [];var _iteratorNormalCompletion7 = true;
          var _didIteratorError7 = false;
          var _iteratorError7 = undefined;

          try {
            for (var _iterator7 = e[Symbol.iterator](), _step7; !(_iteratorNormalCompletion7 = (_step7 = _iterator7.next()).done); _iteratorNormalCompletion7 = true) {
              var _t8 = _step7.value;
              _t8 = r(_t8), n[_t8.actor] = !0, _t8.ops = L(_t8.ops, _t8.startOp, _t8.actor), _t8.ops = _t8.ops.map(function (e) {
                "_root" !== (e = r(e)).obj && (e.obj = o(e.obj)), e.elemId && "_head" !== e.elemId && (e.elemId = o(e.elemId)), e.child && (e.child = o(e.child)), e.pred && (e.pred = e.pred.map(o)), e.obj.actorId && (n[e.obj.actorId] = !0), e.elemId && e.elemId.actorId && (n[e.elemId.actorId] = !0), e.child && e.child.actorId && (n[e.child.actorId] = !0);var _iteratorNormalCompletion9 = true;
                var _didIteratorError9 = false;
                var _iteratorError9 = undefined;

                try {
                  for (var _iterator9 = e.pred[Symbol.iterator](), _step9; !(_iteratorNormalCompletion9 = (_step9 = _iterator9.next()).done); _iteratorNormalCompletion9 = true) {
                    var _t9 = _step9.value;
                    n[_t9.actorId] = !0;
                  }
                } catch (err) {
                  _didIteratorError9 = true;
                  _iteratorError9 = err;
                } finally {
                  try {
                    if (!_iteratorNormalCompletion9 && _iterator9.return) {
                      _iterator9.return();
                    }
                  } finally {
                    if (_didIteratorError9) {
                      throw _iteratorError9;
                    }
                  }
                }

                return e;
              }), s.push(_t8);
            }
          } catch (err) {
            _didIteratorError7 = true;
            _iteratorError7 = err;
          } finally {
            try {
              if (!_iteratorNormalCompletion7 && _iterator7.return) {
                _iterator7.return();
              }
            } finally {
              if (_didIteratorError7) {
                throw _iteratorError7;
              }
            }
          }

          var a = Object.keys(n).sort();t && (a = [e[0].actor].concat(a.filter(function (t) {
            return t !== e[0].actor;
          })));var _iteratorNormalCompletion8 = true;
          var _didIteratorError8 = false;
          var _iteratorError8 = undefined;

          try {
            for (var _iterator8 = s[Symbol.iterator](), _step8; !(_iteratorNormalCompletion8 = (_step8 = _iterator8.next()).done); _iteratorNormalCompletion8 = true) {
              var _e9 = _step8.value;
              _e9.actorNum = a.indexOf(_e9.actor);for (var _t10 = 0; _t10 < _e9.ops.length; _t10++) {
                var _n19 = _e9.ops[_t10];_n19.id = { counter: _e9.startOp + _t10, actorNum: _e9.actorNum, actorId: _e9.actor }, _n19.obj = O(_n19.obj, a), _n19.elemId = O(_n19.elemId, a), _n19.child = O(_n19.child, a), _n19.pred = _n19.pred.map(function (e) {
                  return O(e, a);
                });
              }
            }
          } catch (err) {
            _didIteratorError8 = true;
            _iteratorError8 = err;
          } finally {
            try {
              if (!_iteratorNormalCompletion8 && _iterator8.return) {
                _iterator8.return();
              }
            } finally {
              if (_didIteratorError8) {
                throw _iteratorError8;
              }
            }
          }

          return { changes: s, actorIds: a };
        }([e], !0),
            t = _ref3.changes,
            n = _ref3.actorIds,
            a = t[0],
            _q = q(1, function (e) {
          if (!Array.isArray(a.deps)) throw new TypeError("deps is not an array");e.appendUint53(a.deps.length);var _iteratorNormalCompletion10 = true;
          var _didIteratorError10 = false;
          var _iteratorError10 = undefined;

          try {
            for (var _iterator10 = a.deps.slice().sort()[Symbol.iterator](), _step10; !(_iteratorNormalCompletion10 = (_step10 = _iterator10.next()).done); _iteratorNormalCompletion10 = true) {
              var _t11 = _step10.value;
              e.appendRawBytes(l(_t11));
            }
          } catch (err) {
            _didIteratorError10 = true;
            _iteratorError10 = err;
          } finally {
            try {
              if (!_iteratorNormalCompletion10 && _iterator10.return) {
                _iterator10.return();
              }
            } finally {
              if (_didIteratorError10) {
                throw _iteratorError10;
              }
            }
          }

          e.appendHexString(a.actor), e.appendUint53(a.seq), e.appendUint53(a.startOp), e.appendInt53(a.time), e.appendPrefixedString(a.message || ""), e.appendUint53(n.length - 1);var _iteratorNormalCompletion11 = true;
          var _didIteratorError11 = false;
          var _iteratorError11 = undefined;

          try {
            for (var _iterator11 = n.slice(1)[Symbol.iterator](), _step11; !(_iteratorNormalCompletion11 = (_step11 = _iterator11.next()).done); _iteratorNormalCompletion11 = true) {
              var _t12 = _step11.value;
              e.appendHexString(_t12);
            }
          } catch (err) {
            _didIteratorError11 = true;
            _iteratorError11 = err;
          } finally {
            try {
              if (!_iteratorNormalCompletion11 && _iterator11.return) {
                _iterator11.return();
              }
            } finally {
              if (_didIteratorError11) {
                throw _iteratorError11;
              }
            }
          }

          var t = function (e, t) {
            var n = { objActor: new h("uint"), objCtr: new h("uint"), keyActor: new h("uint"), keyCtr: new p(), keyStr: new h("utf8"), insert: new g(), action: new h("uint"), valLen: new h("uint"), valRaw: new d(), chldActor: new h("uint"), chldCtr: new p() };t ? (n.idActor = new h("uint"), n.idCtr = new p(), n.succNum = new h("uint"), n.succActor = new h("uint"), n.succCtr = new p()) : (n.predNum = new h("uint"), n.predCtr = new p(), n.predActor = new h("uint"));var _iteratorNormalCompletion12 = true;
            var _didIteratorError12 = false;
            var _iteratorError12 = undefined;

            try {
              for (var _iterator12 = e[Symbol.iterator](), _step12; !(_iteratorNormalCompletion12 = (_step12 = _iterator12.next()).done); _iteratorNormalCompletion12 = true) {
                var _s9 = _step12.value;
                if (R(_s9, n), C(_s9, n), n.insert.appendValue(!!_s9.insert), V(_s9, n), S(_s9, n), _s9.child && _s9.child.counter ? (n.chldActor.appendValue(_s9.child.actorNum), n.chldCtr.appendValue(_s9.child.counter)) : (n.chldActor.appendValue(null), n.chldCtr.appendValue(null)), t) {
                  n.idActor.appendValue(_s9.id.actorNum), n.idCtr.appendValue(_s9.id.counter), n.succNum.appendValue(_s9.succ.length), _s9.succ.sort(A);for (var _e11 = 0; _e11 < _s9.succ.length; _e11++) {
                    n.succActor.appendValue(_s9.succ[_e11].actorNum), n.succCtr.appendValue(_s9.succ[_e11].counter);
                  }
                } else {
                  n.predNum.appendValue(_s9.pred.length), _s9.pred.sort(A);for (var _e12 = 0; _e12 < _s9.pred.length; _e12++) {
                    n.predActor.appendValue(_s9.pred[_e12].actorNum), n.predCtr.appendValue(_s9.pred[_e12].counter);
                  }
                }
              }
            } catch (err) {
              _didIteratorError12 = true;
              _iteratorError12 = err;
            } finally {
              try {
                if (!_iteratorNormalCompletion12 && _iterator12.return) {
                  _iterator12.return();
                }
              } finally {
                if (_didIteratorError12) {
                  throw _iteratorError12;
                }
              }
            }

            var s = [];var _iteratorNormalCompletion13 = true;
            var _didIteratorError13 = false;
            var _iteratorError13 = undefined;

            try {
              for (var _iterator13 = (t ? j : x)[Symbol.iterator](), _step13; !(_iteratorNormalCompletion13 = (_step13 = _iterator13.next()).done); _iteratorNormalCompletion13 = true) {
                var _ref4 = _step13.value;
                var _e10 = _ref4.columnName;
                var _r8 = _ref4.columnId;
                n[_e10] && s.push({ columnId: _r8, columnName: _e10, encoder: n[_e10] });
              }
            } catch (err) {
              _didIteratorError13 = true;
              _iteratorError13 = err;
            } finally {
              try {
                if (!_iteratorNormalCompletion13 && _iterator13.return) {
                  _iterator13.return();
                }
              } finally {
                if (_didIteratorError13) {
                  throw _iteratorError13;
                }
              }
            }

            return s.sort(function (e, t) {
              return e.columnId - t.columnId;
            });
          }(a.ops, !1);P(e, t);var _iteratorNormalCompletion14 = true;
          var _didIteratorError14 = false;
          var _iteratorError14 = undefined;

          try {
            for (var _iterator14 = t[Symbol.iterator](), _step14; !(_iteratorNormalCompletion14 = (_step14 = _iterator14.next()).done); _iteratorNormalCompletion14 = true) {
              var _n20 = _step14.value;
              e.appendRawBytes(_n20.encoder.buffer);
            }
          } catch (err) {
            _didIteratorError14 = true;
            _iteratorError14 = err;
          } finally {
            try {
              if (!_iteratorNormalCompletion14 && _iterator14.return) {
                _iterator14.return();
              }
            } finally {
              if (_didIteratorError14) {
                throw _iteratorError14;
              }
            }
          }

          a.extraBytes && e.appendRawBytes(a.extraBytes);
        }),
            i = _q.hash,
            f = _q.bytes,
            b = c(i);

        if (e.hash && e.hash !== b) throw new RangeError("Change hash does not match encoding: " + e.hash + " != " + b);return f.byteLength >= 256 ? function (e) {
          var t = Z(new u(e), !1);if (1 !== t.chunkType) throw new RangeError("Unexpected chunk type: " + t.chunkType);var n = s.deflateRaw(t.chunkData),
              r = new d();return r.appendRawBytes(e.subarray(0, 8)), r.appendByte(2), r.appendUint53(n.byteLength), r.appendRawBytes(n), r.buffer;
        }(f) : f;
      }function K(e) {
        2 === e[8] && (e = Y(e));var t = new u(e),
            n = Z(t, !0),
            s = new u(n.chunkData);if (!t.done) throw new RangeError("Encoded change has trailing data");if (1 !== n.chunkType) throw new RangeError("Unexpected chunk type: " + n.chunkType);var r = F(s),
            o = M(s);for (var _e13 = 0; _e13 < o.length; _e13++) {
          if (0 != (8 & o[_e13].columnId)) throw new RangeError("change must not contain deflated columns");o[_e13].buffer = s.readRawBytes(o[_e13].bufferLen);
        }if (!s.done) {
          var _e14 = s.buf.byteLength - s.offset;r.extraBytes = s.readRawBytes(_e14);
        }return r.columns = o, r.hash = n.hash, r;
      }function W(e) {
        var t = K(e);return t.ops = B($(t.columns, t.actorIds, x), !1), delete t.actorIds, delete t.columns, t;
      }function Y(e) {
        var t = Z(new u(e), !1);if (2 !== t.chunkType) throw new RangeError("Unexpected chunk type: " + t.chunkType);var n = s.inflateRaw(t.chunkData),
            r = new d();return r.appendRawBytes(e.subarray(0, 8)), r.appendByte(1), r.appendUint53(n.byteLength), r.appendRawBytes(n), r.buffer;
      }function J(e) {
        var t = new u(e),
            n = [],
            s = 0;for (; !t.done;) {
          Z(t, !1), n.push(e.subarray(s, t.offset)), s = t.offset;
        }return n;
      }function X(e, t) {
        if (e === t) return 0;if ("_root" === e) return -1;if ("_root" === t) return 1;var n = o(e),
            s = o(t);return n.counter < s.counter ? -1 : n.counter > s.counter ? 1 : n.actorId < s.actorId ? -1 : n.actorId > s.actorId ? 1 : 0;
      }function Q(e) {
        var t = new u(e),
            n = Z(t, !0),
            s = new u(n.chunkData);if (!t.done) throw new RangeError("Encoded document has trailing data");if (0 !== n.chunkType) throw new RangeError("Unexpected chunk type: " + n.chunkType);var r = [],
            o = s.readUint53();for (var _e15 = 0; _e15 < o; _e15++) {
          r.push(s.readHexString());
        }var a = [],
            i = [],
            l = s.readUint53();for (var _e16 = 0; _e16 < l; _e16++) {
          a.push(c(s.readRawBytes(32)));
        }var d = M(s),
            h = M(s);for (var _e17 = 0; _e17 < d.length; _e17++) {
          d[_e17].buffer = s.readRawBytes(d[_e17].bufferLen), ne(d[_e17]);
        }for (var _e18 = 0; _e18 < h.length; _e18++) {
          h[_e18].buffer = s.readRawBytes(h[_e18].bufferLen), ne(h[_e18]);
        }if (!s.done) for (var _e19 = 0; _e19 < l; _e19++) {
          i.push(s.readUint53());
        }return { changesColumns: d, opsColumns: h, actorIds: r, heads: a, headsIndexes: i, extraBytes: s.readRawBytes(s.buf.byteLength - s.offset) };
      }function ee(e) {
        var _Q = Q(e),
            t = _Q.changesColumns,
            n = _Q.opsColumns,
            s = _Q.actorIds,
            r = _Q.heads,
            a = $(t, s, E);

        return function (e, t) {
          var n = {};var _iteratorNormalCompletion15 = true;
          var _didIteratorError15 = false;
          var _iteratorError15 = undefined;

          try {
            for (var _iterator15 = e[Symbol.iterator](), _step15; !(_iteratorNormalCompletion15 = (_step15 = _iterator15.next()).done); _iteratorNormalCompletion15 = true) {
              var _t13 = _step15.value;
              if (_t13.ops = [], n[_t13.actor] || (n[_t13.actor] = []), _t13.seq !== n[_t13.actor].length + 1) throw new RangeError("Expected seq = " + (n[_t13.actor].length + 1) + ", got " + _t13.seq);if (_t13.seq > 1 && n[_t13.actor][_t13.seq - 2].maxOp > _t13.maxOp) throw new RangeError("maxOp must increase monotonically per actor");n[_t13.actor].push(_t13);
            }
          } catch (err) {
            _didIteratorError15 = true;
            _iteratorError15 = err;
          } finally {
            try {
              if (!_iteratorNormalCompletion15 && _iterator15.return) {
                _iterator15.return();
              }
            } finally {
              if (_didIteratorError15) {
                throw _iteratorError15;
              }
            }
          }

          var s = {};var _iteratorNormalCompletion16 = true;
          var _didIteratorError16 = false;
          var _iteratorError16 = undefined;

          try {
            for (var _iterator16 = t[Symbol.iterator](), _step16; !(_iteratorNormalCompletion16 = (_step16 = _iterator16.next()).done); _iteratorNormalCompletion16 = true) {
              var _e20 = _step16.value;
              if ("del" === _e20.action) throw new RangeError("document should not contain del operations");_e20.pred = s[_e20.id] ? s[_e20.id].pred : [], s[_e20.id] = _e20;var _iteratorNormalCompletion20 = true;
              var _didIteratorError20 = false;
              var _iteratorError20 = undefined;

              try {
                for (var _iterator20 = _e20.succ[Symbol.iterator](), _step20; !(_iteratorNormalCompletion20 = (_step20 = _iterator20.next()).done); _iteratorNormalCompletion20 = true) {
                  var _t16 = _step20.value;
                  if (!s[_t16]) if (_e20.elemId) {
                    var _n21 = _e20.insert ? _e20.id : _e20.elemId;s[_t16] = { id: _t16, action: "del", obj: _e20.obj, elemId: _n21, pred: [] };
                  } else s[_t16] = { id: _t16, action: "del", obj: _e20.obj, key: _e20.key, pred: [] };s[_t16].pred.push(_e20.id);
                }
              } catch (err) {
                _didIteratorError20 = true;
                _iteratorError20 = err;
              } finally {
                try {
                  if (!_iteratorNormalCompletion20 && _iterator20.return) {
                    _iterator20.return();
                  }
                } finally {
                  if (_didIteratorError20) {
                    throw _iteratorError20;
                  }
                }
              }

              delete _e20.succ;
            }
          } catch (err) {
            _didIteratorError16 = true;
            _iteratorError16 = err;
          } finally {
            try {
              if (!_iteratorNormalCompletion16 && _iterator16.return) {
                _iterator16.return();
              }
            } finally {
              if (_didIteratorError16) {
                throw _iteratorError16;
              }
            }
          }

          var _iteratorNormalCompletion17 = true;
          var _didIteratorError17 = false;
          var _iteratorError17 = undefined;

          try {
            for (var _iterator17 = Object.values(s)[Symbol.iterator](), _step17; !(_iteratorNormalCompletion17 = (_step17 = _iterator17.next()).done); _iteratorNormalCompletion17 = true) {
              var _e21 = _step17.value;
              "del" === _e21.action && t.push(_e21);
            }
          } catch (err) {
            _didIteratorError17 = true;
            _iteratorError17 = err;
          } finally {
            try {
              if (!_iteratorNormalCompletion17 && _iterator17.return) {
                _iterator17.return();
              }
            } finally {
              if (_didIteratorError17) {
                throw _iteratorError17;
              }
            }
          }

          var _iteratorNormalCompletion18 = true;
          var _didIteratorError18 = false;
          var _iteratorError18 = undefined;

          try {
            for (var _iterator18 = t[Symbol.iterator](), _step18; !(_iteratorNormalCompletion18 = (_step18 = _iterator18.next()).done); _iteratorNormalCompletion18 = true) {
              var _e22 = _step18.value;

              var _o8 = o(_e22.id),
                  _t14 = _o8.counter,
                  _s10 = _o8.actorId,
                  _r9 = n[_s10];

              var _a6 = 0,
                  _i4 = _r9.length;for (; _a6 < _i4;) {
                var _e23 = Math.floor((_a6 + _i4) / 2);_r9[_e23].maxOp < _t14 ? _a6 = _e23 + 1 : _i4 = _e23;
              }if (_a6 >= _r9.length) throw new RangeError("Operation ID " + _e22.id + " outside of allowed range");_r9[_a6].ops.push(_e22);
            }
          } catch (err) {
            _didIteratorError18 = true;
            _iteratorError18 = err;
          } finally {
            try {
              if (!_iteratorNormalCompletion18 && _iterator18.return) {
                _iterator18.return();
              }
            } finally {
              if (_didIteratorError18) {
                throw _iteratorError18;
              }
            }
          }

          var _iteratorNormalCompletion19 = true;
          var _didIteratorError19 = false;
          var _iteratorError19 = undefined;

          try {
            for (var _iterator19 = e[Symbol.iterator](), _step19; !(_iteratorNormalCompletion19 = (_step19 = _iterator19.next()).done); _iteratorNormalCompletion19 = true) {
              var _t15 = _step19.value;
              _t15.ops.sort(function (e, t) {
                return X(e.id, t.id);
              }), _t15.startOp = _t15.maxOp - _t15.ops.length + 1, delete _t15.maxOp;for (var _e24 = 0; _e24 < _t15.ops.length; _e24++) {
                var _n22 = _t15.ops[_e24],
                    _s11 = _t15.startOp + _e24 + "@" + _t15.actor;if (_n22.id !== _s11) throw new RangeError("Expected opId " + _s11 + ", got " + _n22.id);delete _n22.id;
              }
            }
          } catch (err) {
            _didIteratorError19 = true;
            _iteratorError19 = err;
          } finally {
            try {
              if (!_iteratorNormalCompletion19 && _iterator19.return) {
                _iterator19.return();
              }
            } finally {
              if (_didIteratorError19) {
                throw _iteratorError19;
              }
            }
          }
        }(a, B($(n, s, j), !0)), function (e, t) {
          var n = {};for (var _t17 = 0; _t17 < e.length; _t17++) {
            var _s12 = e[_t17];_s12.deps = [];var _iteratorNormalCompletion21 = true;
            var _didIteratorError21 = false;
            var _iteratorError21 = undefined;

            try {
              for (var _iterator21 = _s12.depsNum.map(function (e) {
                return e.depsIndex;
              })[Symbol.iterator](), _step21; !(_iteratorNormalCompletion21 = (_step21 = _iterator21.next()).done); _iteratorNormalCompletion21 = true) {
                var _r10 = _step21.value;
                if (!e[_r10] || !e[_r10].hash) throw new RangeError("No hash for index " + _r10 + " while processing index " + _t17);var _o9 = e[_r10].hash;_s12.deps.push(_o9), n[_o9] && delete n[_o9];
              }
            } catch (err) {
              _didIteratorError21 = true;
              _iteratorError21 = err;
            } finally {
              try {
                if (!_iteratorNormalCompletion21 && _iterator21.return) {
                  _iterator21.return();
                }
              } finally {
                if (_didIteratorError21) {
                  throw _iteratorError21;
                }
              }
            }

            if (_s12.deps.sort(), delete _s12.depsNum, _s12.extraLen_datatype !== I.BYTES) throw new RangeError("Bad datatype for extra bytes: " + I.BYTES);_s12.extraBytes = _s12.extraLen, delete _s12.extraLen_datatype, e[_t17] = W(G(_s12)), n[e[_t17].hash] = !0;
          }var s = Object.keys(n).sort();var r = s.length === t.length,
              o = 0;for (; r && o < s.length;) {
            r = s[o] === t[o], o++;
          }if (!r) throw new RangeError("Mismatched heads hashes: expected " + t.join(", ") + ", got " + s.join(", "));
        }(a, r), a;
      }function te(e) {
        e.encoder.buffer.byteLength >= 256 && (e.encoder = { buffer: s.deflateRaw(e.encoder.buffer) }, e.columnId |= 8);
      }function ne(e) {
        0 != (8 & e.columnId) && (e.buffer = s.inflateRaw(e.buffer), e.columnId ^= 8);
      }e.exports = { COLUMN_TYPE: _, VALUE_TYPE: I, ACTIONS: v, OBJECT_TYPE: { makeMap: "map", makeList: "list", makeText: "text", makeTable: "table" }, DOC_OPS_COLUMNS: j, CHANGE_COLUMNS: x, DOCUMENT_COLUMNS: E, encoderByColumnId: function encoderByColumnId(e) {
          return (7 & e) === _.INT_DELTA ? new p() : (7 & e) === _.BOOLEAN ? new g() : (7 & e) === _.STRING_RLE ? new h("utf8") : (7 & e) === _.VALUE_RAW ? new d() : new h("uint");
        }, decoderByColumnId: D, makeDecoders: H, decodeValue: N, splitContainers: J, encodeChange: G, decodeChangeColumns: K, decodeChange: W, decodeChangeMeta: function decodeChangeMeta(e, t) {
          2 === e[8] && (e = Y(e));var n = Z(new u(e), t);if (1 !== n.chunkType) throw new RangeError("Buffer chunk type is not a change");var s = F(new u(n.chunkData));return s.change = e, t && (s.hash = n.hash), s;
        }, decodeChanges: function decodeChanges(e) {
          var t = [];var _iteratorNormalCompletion22 = true;
          var _didIteratorError22 = false;
          var _iteratorError22 = undefined;

          try {
            for (var _iterator22 = e[Symbol.iterator](), _step22; !(_iteratorNormalCompletion22 = (_step22 = _iterator22.next()).done); _iteratorNormalCompletion22 = true) {
              var _n23 = _step22.value;
              var _iteratorNormalCompletion23 = true;
              var _didIteratorError23 = false;
              var _iteratorError23 = undefined;

              try {
                for (var _iterator23 = J(_n23)[Symbol.iterator](), _step23; !(_iteratorNormalCompletion23 = (_step23 = _iterator23.next()).done); _iteratorNormalCompletion23 = true) {
                  var _e25 = _step23.value;
                  0 === _e25[8] ? t = t.concat(ee(_e25)) : 1 !== _e25[8] && 2 !== _e25[8] || t.push(W(_e25));
                }
              } catch (err) {
                _didIteratorError23 = true;
                _iteratorError23 = err;
              } finally {
                try {
                  if (!_iteratorNormalCompletion23 && _iterator23.return) {
                    _iterator23.return();
                  }
                } finally {
                  if (_didIteratorError23) {
                    throw _iteratorError23;
                  }
                }
              }
            }
          } catch (err) {
            _didIteratorError22 = true;
            _iteratorError22 = err;
          } finally {
            try {
              if (!_iteratorNormalCompletion22 && _iterator22.return) {
                _iterator22.return();
              }
            } finally {
              if (_didIteratorError22) {
                throw _iteratorError22;
              }
            }
          }

          return t;
        }, encodeDocumentHeader: function encodeDocumentHeader(e) {
          var t = e.changesColumns,
              n = e.opsColumns,
              s = e.actorIds,
              r = e.heads,
              o = e.headsIndexes,
              a = e.extraBytes;
          var _iteratorNormalCompletion24 = true;
          var _didIteratorError24 = false;
          var _iteratorError24 = undefined;

          try {
            for (var _iterator24 = t[Symbol.iterator](), _step24; !(_iteratorNormalCompletion24 = (_step24 = _iterator24.next()).done); _iteratorNormalCompletion24 = true) {
              var _e26 = _step24.value;
              te(_e26);
            }
          } catch (err) {
            _didIteratorError24 = true;
            _iteratorError24 = err;
          } finally {
            try {
              if (!_iteratorNormalCompletion24 && _iterator24.return) {
                _iterator24.return();
              }
            } finally {
              if (_didIteratorError24) {
                throw _iteratorError24;
              }
            }
          }

          var _iteratorNormalCompletion25 = true;
          var _didIteratorError25 = false;
          var _iteratorError25 = undefined;

          try {
            for (var _iterator25 = n[Symbol.iterator](), _step25; !(_iteratorNormalCompletion25 = (_step25 = _iterator25.next()).done); _iteratorNormalCompletion25 = true) {
              var _e27 = _step25.value;
              te(_e27);
            }
          } catch (err) {
            _didIteratorError25 = true;
            _iteratorError25 = err;
          } finally {
            try {
              if (!_iteratorNormalCompletion25 && _iterator25.return) {
                _iterator25.return();
              }
            } finally {
              if (_didIteratorError25) {
                throw _iteratorError25;
              }
            }
          }

          return q(0, function (e) {
            e.appendUint53(s.length);var _iteratorNormalCompletion26 = true;
            var _didIteratorError26 = false;
            var _iteratorError26 = undefined;

            try {
              for (var _iterator26 = s[Symbol.iterator](), _step26; !(_iteratorNormalCompletion26 = (_step26 = _iterator26.next()).done); _iteratorNormalCompletion26 = true) {
                var _t18 = _step26.value;
                e.appendHexString(_t18);
              }
            } catch (err) {
              _didIteratorError26 = true;
              _iteratorError26 = err;
            } finally {
              try {
                if (!_iteratorNormalCompletion26 && _iterator26.return) {
                  _iterator26.return();
                }
              } finally {
                if (_didIteratorError26) {
                  throw _iteratorError26;
                }
              }
            }

            e.appendUint53(r.length);var _iteratorNormalCompletion27 = true;
            var _didIteratorError27 = false;
            var _iteratorError27 = undefined;

            try {
              for (var _iterator27 = r.sort()[Symbol.iterator](), _step27; !(_iteratorNormalCompletion27 = (_step27 = _iterator27.next()).done); _iteratorNormalCompletion27 = true) {
                var _t19 = _step27.value;
                e.appendRawBytes(l(_t19));
              }
            } catch (err) {
              _didIteratorError27 = true;
              _iteratorError27 = err;
            } finally {
              try {
                if (!_iteratorNormalCompletion27 && _iterator27.return) {
                  _iterator27.return();
                }
              } finally {
                if (_didIteratorError27) {
                  throw _iteratorError27;
                }
              }
            }

            P(e, t), P(e, n);var _iteratorNormalCompletion28 = true;
            var _didIteratorError28 = false;
            var _iteratorError28 = undefined;

            try {
              for (var _iterator28 = t[Symbol.iterator](), _step28; !(_iteratorNormalCompletion28 = (_step28 = _iterator28.next()).done); _iteratorNormalCompletion28 = true) {
                var _n24 = _step28.value;
                e.appendRawBytes(_n24.encoder.buffer);
              }
            } catch (err) {
              _didIteratorError28 = true;
              _iteratorError28 = err;
            } finally {
              try {
                if (!_iteratorNormalCompletion28 && _iterator28.return) {
                  _iterator28.return();
                }
              } finally {
                if (_didIteratorError28) {
                  throw _iteratorError28;
                }
              }
            }

            var _iteratorNormalCompletion29 = true;
            var _didIteratorError29 = false;
            var _iteratorError29 = undefined;

            try {
              for (var _iterator29 = n[Symbol.iterator](), _step29; !(_iteratorNormalCompletion29 = (_step29 = _iterator29.next()).done); _iteratorNormalCompletion29 = true) {
                var _t20 = _step29.value;
                e.appendRawBytes(_t20.encoder.buffer);
              }
            } catch (err) {
              _didIteratorError29 = true;
              _iteratorError29 = err;
            } finally {
              try {
                if (!_iteratorNormalCompletion29 && _iterator29.return) {
                  _iterator29.return();
                }
              } finally {
                if (_didIteratorError29) {
                  throw _iteratorError29;
                }
              }
            }

            var _iteratorNormalCompletion30 = true;
            var _didIteratorError30 = false;
            var _iteratorError30 = undefined;

            try {
              for (var _iterator30 = o[Symbol.iterator](), _step30; !(_iteratorNormalCompletion30 = (_step30 = _iterator30.next()).done); _iteratorNormalCompletion30 = true) {
                var _t21 = _step30.value;
                e.appendUint53(_t21);
              }
            } catch (err) {
              _didIteratorError30 = true;
              _iteratorError30 = err;
            } finally {
              try {
                if (!_iteratorNormalCompletion30 && _iterator30.return) {
                  _iterator30.return();
                }
              } finally {
                if (_didIteratorError30) {
                  throw _iteratorError30;
                }
              }
            }

            a && e.appendRawBytes(a);
          }).bytes;
        }, decodeDocumentHeader: Q, decodeDocument: ee };
    }, "./backend/encoding.js":
    /*!*****************************!*\
      !*** ./backend/encoding.js ***!
      \*****************************/function backendEncodingJs(e) {
      var t = new polyfill.TextEncoder(),
          n = new polyfill.TextDecoder("utf-8");function s(e) {
        return t.encode(e);
      }function r(e) {
        return n.decode(e);
      }function o(e) {
        if ("string" != typeof e) throw new TypeError("value is not a string");if (!/^([0-9a-f][0-9a-f])*$/.test(e)) throw new RangeError("value is not hexadecimal");return "" === e ? new Uint8Array(0) : new Uint8Array(e.match(/../g).map(function (e) {
          return parseInt(e, 16);
        }));
      }var a = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "a", "b", "c", "d", "e", "f"],
          i = new Array(256);for (var _e28 = 0; _e28 < 256; _e28++) {
        i[_e28] = "" + a[_e28 >>> 4 & 15] + a[15 & _e28];
      }function l(e) {
        var t = "",
            n = e.byteLength;for (var _s13 = 0; _s13 < n; _s13++) {
          t += i[e[_s13]];
        }return t;
      }
      var c = function () {
        function c() {
          _classCallCheck(this, c);

          this.buf = new Uint8Array(16), this.offset = 0;
        }

        _createClass(c, [{
          key: "grow",
          value: function grow() {
            var e = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : 0;
            var t = 4 * this.buf.byteLength;for (; t < e;) {
              t *= 2;
            }var n = new Uint8Array(t);return n.set(this.buf, 0), this.buf = n, this;
          }
        }, {
          key: "appendByte",
          value: function appendByte(e) {
            this.offset >= this.buf.byteLength && this.grow(), this.buf[this.offset] = e, this.offset += 1;
          }
        }, {
          key: "appendUint32",
          value: function appendUint32(e) {
            if (!Number.isInteger(e)) throw new RangeError("value is not an integer");if (e < 0 || e > 4294967295) throw new RangeError("number out of range");var t = Math.max(1, Math.ceil((32 - Math.clz32(e)) / 7));this.offset + t > this.buf.byteLength && this.grow();for (var _n25 = 0; _n25 < t; _n25++) {
              this.buf[this.offset + _n25] = 127 & e | (_n25 === t - 1 ? 0 : 128), e >>>= 7;
            }return this.offset += t, t;
          }
        }, {
          key: "appendInt32",
          value: function appendInt32(e) {
            if (!Number.isInteger(e)) throw new RangeError("value is not an integer");if (e < -2147483648 || e > 2147483647) throw new RangeError("number out of range");var t = Math.ceil((33 - Math.clz32(e >= 0 ? e : -e - 1)) / 7);this.offset + t > this.buf.byteLength && this.grow();for (var _n26 = 0; _n26 < t; _n26++) {
              this.buf[this.offset + _n26] = 127 & e | (_n26 === t - 1 ? 0 : 128), e >>= 7;
            }return this.offset += t, t;
          }
        }, {
          key: "appendUint53",
          value: function appendUint53(e) {
            if (!Number.isInteger(e)) throw new RangeError("value is not an integer");if (e < 0 || e > Number.MAX_SAFE_INTEGER) throw new RangeError("number out of range");var t = Math.floor(e / 4294967296),
                n = (4294967295 & e) >>> 0;return this.appendUint64(t, n);
          }
        }, {
          key: "appendInt53",
          value: function appendInt53(e) {
            if (!Number.isInteger(e)) throw new RangeError("value is not an integer");if (e < Number.MIN_SAFE_INTEGER || e > Number.MAX_SAFE_INTEGER) throw new RangeError("number out of range");var t = Math.floor(e / 4294967296),
                n = (4294967295 & e) >>> 0;return this.appendInt64(t, n);
          }
        }, {
          key: "appendUint64",
          value: function appendUint64(e, t) {
            if (!Number.isInteger(e) || !Number.isInteger(t)) throw new RangeError("value is not an integer");if (e < 0 || e > 4294967295 || t < 0 || t > 4294967295) throw new RangeError("number out of range");if (0 === e) return this.appendUint32(t);var n = Math.ceil((64 - Math.clz32(e)) / 7);this.offset + n > this.buf.byteLength && this.grow();for (var _e29 = 0; _e29 < 4; _e29++) {
              this.buf[this.offset + _e29] = 127 & t | 128, t >>>= 7;
            }this.buf[this.offset + 4] = 15 & t | (7 & e) << 4 | (5 === n ? 0 : 128), e >>>= 3;for (var _t22 = 5; _t22 < n; _t22++) {
              this.buf[this.offset + _t22] = 127 & e | (_t22 === n - 1 ? 0 : 128), e >>>= 7;
            }return this.offset += n, n;
          }
        }, {
          key: "appendInt64",
          value: function appendInt64(e, t) {
            if (!Number.isInteger(e) || !Number.isInteger(t)) throw new RangeError("value is not an integer");if (e < -2147483648 || e > 2147483647 || t < -2147483648 || t > 4294967295) throw new RangeError("number out of range");if (t >>>= 0, 0 === e && t <= 2147483647) return this.appendInt32(t);if (-1 === e && t >= 2147483648) return this.appendInt32(t - 4294967296);var n = Math.ceil((65 - Math.clz32(e >= 0 ? e : -e - 1)) / 7);this.offset + n > this.buf.byteLength && this.grow();for (var _e30 = 0; _e30 < 4; _e30++) {
              this.buf[this.offset + _e30] = 127 & t | 128, t >>>= 7;
            }this.buf[this.offset + 4] = 15 & t | (7 & e) << 4 | (5 === n ? 0 : 128), e >>= 3;for (var _t23 = 5; _t23 < n; _t23++) {
              this.buf[this.offset + _t23] = 127 & e | (_t23 === n - 1 ? 0 : 128), e >>= 7;
            }return this.offset += n, n;
          }
        }, {
          key: "appendRawBytes",
          value: function appendRawBytes(e) {
            return this.offset + e.byteLength > this.buf.byteLength && this.grow(this.offset + e.byteLength), this.buf.set(e, this.offset), this.offset += e.byteLength, e.byteLength;
          }
        }, {
          key: "appendRawString",
          value: function appendRawString(e) {
            if ("string" != typeof e) throw new TypeError("value is not a string");return this.appendRawBytes(s(e));
          }
        }, {
          key: "appendPrefixedBytes",
          value: function appendPrefixedBytes(e) {
            return this.appendUint53(e.byteLength), this.appendRawBytes(e), this;
          }
        }, {
          key: "appendPrefixedString",
          value: function appendPrefixedString(e) {
            if ("string" != typeof e) throw new TypeError("value is not a string");return this.appendPrefixedBytes(s(e)), this;
          }
        }, {
          key: "appendHexString",
          value: function appendHexString(e) {
            return this.appendPrefixedBytes(o(e)), this;
          }
        }, {
          key: "finish",
          value: function finish() {}
        }, {
          key: "buffer",
          get: function get() {
            return this.finish(), this.buf.subarray(0, this.offset);
          }
        }]);

        return c;
      }();

      var d = function () {
        function d(e) {
          _classCallCheck(this, d);

          if (!(e instanceof Uint8Array)) throw new TypeError("Not a byte array: " + e);this.buf = e, this.offset = 0;
        }

        _createClass(d, [{
          key: "reset",
          value: function reset() {
            this.offset = 0;
          }
        }, {
          key: "skip",
          value: function skip(e) {
            if (this.offset + e > this.buf.byteLength) throw new RangeError("cannot skip beyond end of buffer");this.offset += e;
          }
        }, {
          key: "readByte",
          value: function readByte() {
            return this.offset += 1, this.buf[this.offset - 1];
          }
        }, {
          key: "readUint32",
          value: function readUint32() {
            var e = 0,
                t = 0;for (; this.offset < this.buf.byteLength;) {
              var _n27 = this.buf[this.offset];if (28 === t && 0 != (240 & _n27)) throw new RangeError("number out of range");if (e = (e | (127 & _n27) << t) >>> 0, t += 7, this.offset++, 0 == (128 & _n27)) return e;
            }throw new RangeError("buffer ended with incomplete number");
          }
        }, {
          key: "readInt32",
          value: function readInt32() {
            var e = 0,
                t = 0;for (; this.offset < this.buf.byteLength;) {
              var _n28 = this.buf[this.offset];if (28 === t && 0 != (128 & _n28) || 28 === t && 0 == (64 & _n28) && 0 != (56 & _n28) || 28 === t && 0 != (64 & _n28) && 56 != (56 & _n28)) throw new RangeError("number out of range");if (e |= (127 & _n28) << t, t += 7, this.offset++, 0 == (128 & _n28)) return 0 == (64 & _n28) || t > 28 ? e : e | -1 << t;
            }throw new RangeError("buffer ended with incomplete number");
          }
        }, {
          key: "readUint53",
          value: function readUint53() {
            var _readUint = this.readUint64(),
                e = _readUint.low32,
                t = _readUint.high32;

            if (t < 0 || t > 2097151) throw new RangeError("number out of range");return 4294967296 * t + e;
          }
        }, {
          key: "readInt53",
          value: function readInt53() {
            var _readInt = this.readInt64(),
                e = _readInt.low32,
                t = _readInt.high32;

            if (t < -2097152 || -2097152 === t && 0 === e || t > 2097151) throw new RangeError("number out of range");return 4294967296 * t + e;
          }
        }, {
          key: "readUint64",
          value: function readUint64() {
            var e = 0,
                t = 0,
                n = 0;for (; this.offset < this.buf.byteLength && n <= 28;) {
              var _s14 = this.buf[this.offset];if (e = (e | (127 & _s14) << n) >>> 0, 28 === n && (t = (112 & _s14) >>> 4), n += 7, this.offset++, 0 == (128 & _s14)) return { high32: t, low32: e };
            }for (n = 3; this.offset < this.buf.byteLength;) {
              var _s15 = this.buf[this.offset];if (31 === n && 0 != (254 & _s15)) throw new RangeError("number out of range");if (t = (t | (127 & _s15) << n) >>> 0, n += 7, this.offset++, 0 == (128 & _s15)) return { high32: t, low32: e };
            }throw new RangeError("buffer ended with incomplete number");
          }
        }, {
          key: "readInt64",
          value: function readInt64() {
            var e = 0,
                t = 0,
                n = 0;for (; this.offset < this.buf.byteLength && n <= 28;) {
              var _s16 = this.buf[this.offset];if (e = (e | (127 & _s16) << n) >>> 0, 28 === n && (t = (112 & _s16) >>> 4), n += 7, this.offset++, 0 == (128 & _s16)) return 0 != (64 & _s16) && (n < 32 && (e = (e | -1 << n) >>> 0), t |= -1 << Math.max(n - 32, 0)), { high32: t, low32: e };
            }for (n = 3; this.offset < this.buf.byteLength;) {
              var _s17 = this.buf[this.offset];if (31 === n && 0 !== _s17 && 127 !== _s17) throw new RangeError("number out of range");if (t |= (127 & _s17) << n, n += 7, this.offset++, 0 == (128 & _s17)) return 0 != (64 & _s17) && n < 32 && (t |= -1 << n), { high32: t, low32: e };
            }throw new RangeError("buffer ended with incomplete number");
          }
        }, {
          key: "readRawBytes",
          value: function readRawBytes(e) {
            var t = this.offset;if (t + e > this.buf.byteLength) throw new RangeError("subarray exceeds buffer size");return this.offset += e, this.buf.subarray(t, this.offset);
          }
        }, {
          key: "readRawString",
          value: function readRawString(e) {
            return r(this.readRawBytes(e));
          }
        }, {
          key: "readPrefixedBytes",
          value: function readPrefixedBytes() {
            return this.readRawBytes(this.readUint53());
          }
        }, {
          key: "readPrefixedString",
          value: function readPrefixedString() {
            return r(this.readPrefixedBytes());
          }
        }, {
          key: "readHexString",
          value: function readHexString() {
            return l(this.readPrefixedBytes());
          }
        }, {
          key: "done",
          get: function get() {
            return this.offset === this.buf.byteLength;
          }
        }]);

        return d;
      }();

      var u = function (_c) {
        _inherits(u, _c);

        function u(e) {
          var _this;

          _classCallCheck(this, u);

          (_this = _possibleConstructorReturn(this, (u.__proto__ || Object.getPrototypeOf(u)).call(this)), _this), _this.type = e, _this.state = "empty", _this.lastValue = void 0, _this.count = 0, _this.literal = [];return _this;
        }

        _createClass(u, [{
          key: "appendValue",
          value: function appendValue(e) {
            var t = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : 1;
            this._appendValue(e, t);
          }
        }, {
          key: "_appendValue",
          value: function _appendValue(e) {
            var t = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : 1;
            t <= 0 || ("empty" === this.state ? (this.state = null === e ? "nulls" : 1 === t ? "loneValue" : "repetition", this.lastValue = e, this.count = t) : "loneValue" === this.state ? null === e ? (this.flush(), this.state = "nulls", this.count = t) : e === this.lastValue ? (this.state = "repetition", this.count = 1 + t) : t > 1 ? (this.flush(), this.state = "repetition", this.count = t, this.lastValue = e) : (this.state = "literal", this.literal = [this.lastValue], this.lastValue = e) : "repetition" === this.state ? null === e ? (this.flush(), this.state = "nulls", this.count = t) : e === this.lastValue ? this.count += t : t > 1 ? (this.flush(), this.state = "repetition", this.count = t, this.lastValue = e) : (this.flush(), this.state = "loneValue", this.lastValue = e) : "literal" === this.state ? null === e ? (this.literal.push(this.lastValue), this.flush(), this.state = "nulls", this.count = t) : e === this.lastValue ? (this.flush(), this.state = "repetition", this.count = 1 + t) : t > 1 ? (this.literal.push(this.lastValue), this.flush(), this.state = "repetition", this.count = t, this.lastValue = e) : (this.literal.push(this.lastValue), this.lastValue = e) : "nulls" === this.state && (null === e ? this.count += t : t > 1 ? (this.flush(), this.state = "repetition", this.count = t, this.lastValue = e) : (this.flush(), this.state = "loneValue", this.lastValue = e)));
          }
        }, {
          key: "copyFrom",
          value: function copyFrom(e) {
            var t = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};
            var n = t.count,
                s = t.sumValues,
                r = t.sumShift;
            if (!(e instanceof h) || e.type !== this.type) throw new TypeError("incompatible type of decoder");var o = "number" == typeof n ? n : Number.MAX_SAFE_INTEGER,
                a = 0,
                i = 0;if (n && o > 0 && e.done) throw new RangeError("cannot copy " + n + " values");if (0 === o || e.done) return s ? { nonNullValues: a, sum: i } : { nonNullValues: a };var l = e.readValue();if (null === l) {
              var _t24 = Math.min(e.count + 1, o);if (o -= _t24, e.count -= _t24 - 1, this.appendValue(null, _t24), n && o > 0 && e.done) throw new RangeError("cannot copy " + n + " values");if (0 === o || e.done) return s ? { nonNullValues: a, sum: i } : { nonNullValues: a };if (l = e.readValue(), null === l) throw new RangeError("null run must be followed by non-null value");
            }if (this.appendValue(l), o--, a++, s && (i += r ? l >>> r : l), n && o > 0 && e.done) throw new RangeError("cannot copy " + n + " values");if (0 === o || e.done) return s ? { nonNullValues: a, sum: i } : { nonNullValues: a };var c = e.count > 0;for (; o > 0 && !e.done;) {
              c || e.readRecord();var _t25 = Math.min(e.count, o);if (e.count -= _t25, "literal" === e.state) {
                a += _t25;for (var _n29 = 0; _n29 < _t25; _n29++) {
                  if (e.done) throw new RangeError("incomplete literal");var _t26 = e.readRawValue();if (_t26 === e.lastValue) throw new RangeError("Repetition of values is not allowed in literal");e.lastValue = _t26, this._appendValue(_t26), s && (i += r ? _t26 >>> r : _t26);
                }
              } else if ("repetition" === e.state) {
                a += _t25, s && (i += _t25 * (r ? e.lastValue >>> r : e.lastValue));var _n30 = e.lastValue;if (this._appendValue(_n30), _t25 > 1) {
                  if (this._appendValue(_n30), "repetition" !== this.state) throw new RangeError("Unexpected state " + this.state);this.count += _t25 - 2;
                }
              } else if ("nulls" === e.state) {
                if (this._appendValue(null), "nulls" !== this.state) throw new RangeError("Unexpected state " + this.state);this.count += _t25 - 1;
              }c = !1, o -= _t25;
            }if (n && o > 0 && e.done) throw new RangeError("cannot copy " + n + " values");return s ? { nonNullValues: a, sum: i } : { nonNullValues: a };
          }
        }, {
          key: "flush",
          value: function flush() {
            if ("loneValue" === this.state) this.appendInt32(-1), this.appendRawValue(this.lastValue);else if ("repetition" === this.state) this.appendInt53(this.count), this.appendRawValue(this.lastValue);else if ("literal" === this.state) {
              this.appendInt53(-this.literal.length);var _iteratorNormalCompletion31 = true;
              var _didIteratorError31 = false;
              var _iteratorError31 = undefined;

              try {
                for (var _iterator31 = this.literal[Symbol.iterator](), _step31; !(_iteratorNormalCompletion31 = (_step31 = _iterator31.next()).done); _iteratorNormalCompletion31 = true) {
                  var _e31 = _step31.value;
                  this.appendRawValue(_e31);
                }
              } catch (err) {
                _didIteratorError31 = true;
                _iteratorError31 = err;
              } finally {
                try {
                  if (!_iteratorNormalCompletion31 && _iterator31.return) {
                    _iterator31.return();
                  }
                } finally {
                  if (_didIteratorError31) {
                    throw _iteratorError31;
                  }
                }
              }
            } else "nulls" === this.state && (this.appendInt32(0), this.appendUint53(this.count));this.state = "empty";
          }
        }, {
          key: "appendRawValue",
          value: function appendRawValue(e) {
            if ("int" === this.type) this.appendInt53(e);else if ("uint" === this.type) this.appendUint53(e);else {
              if ("utf8" !== this.type) throw new RangeError("Unknown RLEEncoder datatype: " + this.type);this.appendPrefixedString(e);
            }
          }
        }, {
          key: "finish",
          value: function finish() {
            "literal" === this.state && this.literal.push(this.lastValue), ("nulls" !== this.state || this.offset > 0) && this.flush();
          }
        }]);

        return u;
      }(c);

      var h = function (_d) {
        _inherits(h, _d);

        function h(e, t) {
          var _this2;

          _classCallCheck(this, h);

          (_this2 = _possibleConstructorReturn(this, (h.__proto__ || Object.getPrototypeOf(h)).call(this, t)), _this2), _this2.type = e, _this2.lastValue = void 0, _this2.count = 0, _this2.state = void 0;return _this2;
        }

        _createClass(h, [{
          key: "reset",
          value: function reset() {
            this.offset = 0, this.lastValue = void 0, this.count = 0, this.state = void 0;
          }
        }, {
          key: "readValue",
          value: function readValue() {
            if (this.done) return null;if (0 === this.count && this.readRecord(), this.count -= 1, "literal" === this.state) {
              var _e32 = this.readRawValue();if (_e32 === this.lastValue) throw new RangeError("Repetition of values is not allowed in literal");return this.lastValue = _e32, _e32;
            }return this.lastValue;
          }
        }, {
          key: "skipValues",
          value: function skipValues(e) {
            for (; e > 0 && !this.done;) {
              0 === this.count && (this.count = this.readInt53(), this.count > 0 ? (this.lastValue = this.count <= e ? this.skipRawValues(1) : this.readRawValue(), this.state = "repetition") : this.count < 0 ? (this.count = -this.count, this.state = "literal") : (this.count = this.readUint53(), this.lastValue = null, this.state = "nulls"));var _t27 = Math.min(e, this.count);"literal" === this.state && this.skipRawValues(_t27), e -= _t27, this.count -= _t27;
            }
          }
        }, {
          key: "readRecord",
          value: function readRecord() {
            if (this.count = this.readInt53(), this.count > 1) {
              var _e33 = this.readRawValue();if (("repetition" === this.state || "literal" === this.state) && this.lastValue === _e33) throw new RangeError("Successive repetitions with the same value are not allowed");this.state = "repetition", this.lastValue = _e33;
            } else {
              if (1 === this.count) throw new RangeError("Repetition count of 1 is not allowed, use a literal instead");if (this.count < 0) {
                if (this.count = -this.count, "literal" === this.state) throw new RangeError("Successive literals are not allowed");this.state = "literal";
              } else {
                if ("nulls" === this.state) throw new RangeError("Successive null runs are not allowed");if (this.count = this.readUint53(), 0 === this.count) throw new RangeError("Zero-length null runs are not allowed");this.lastValue = null, this.state = "nulls";
              }
            }
          }
        }, {
          key: "readRawValue",
          value: function readRawValue() {
            if ("int" === this.type) return this.readInt53();if ("uint" === this.type) return this.readUint53();if ("utf8" === this.type) return this.readPrefixedString();throw new RangeError("Unknown RLEDecoder datatype: " + this.type);
          }
        }, {
          key: "skipRawValues",
          value: function skipRawValues(e) {
            if ("utf8" === this.type) for (var _t28 = 0; _t28 < e; _t28++) {
              this.skip(this.readUint53());
            } else {
              for (; e > 0 && this.offset < this.buf.byteLength;) {
                0 == (128 & this.buf[this.offset]) && e--, this.offset++;
              }if (e > 0) throw new RangeError("cannot skip beyond end of buffer");
            }
          }
        }, {
          key: "done",
          get: function get() {
            return 0 === this.count && this.offset === this.buf.byteLength;
          }
        }]);

        return h;
      }(d);

      var f = function (_h) {
        _inherits(f, _h);

        function f(e) {
          var _this3;

          _classCallCheck(this, f);

          (_this3 = _possibleConstructorReturn(this, (f.__proto__ || Object.getPrototypeOf(f)).call(this, "int", e)), _this3), _this3.absoluteValue = 0;return _this3;
        }

        _createClass(f, [{
          key: "reset",
          value: function reset() {
            this.offset = 0, this.lastValue = void 0, this.count = 0, this.state = void 0, this.absoluteValue = 0;
          }
        }, {
          key: "readValue",
          value: function readValue() {
            var e = _get(f.prototype.__proto__ || Object.getPrototypeOf(f.prototype), "readValue", this).call(this);return null === e ? null : (this.absoluteValue += e, this.absoluteValue);
          }
        }, {
          key: "skipValues",
          value: function skipValues(e) {
            for (; e > 0 && !this.done;) {
              0 === this.count && this.readRecord();var _t29 = Math.min(e, this.count);if ("literal" === this.state) for (var _e34 = 0; _e34 < _t29; _e34++) {
                this.lastValue = this.readRawValue(), this.absoluteValue += this.lastValue;
              } else "repetition" === this.state && (this.absoluteValue += _t29 * this.lastValue);e -= _t29, this.count -= _t29;
            }
          }
        }]);

        return f;
      }(h);

      var p = function (_d2) {
        _inherits(p, _d2);

        function p(e) {
          var _this4;

          _classCallCheck(this, p);

          (_this4 = _possibleConstructorReturn(this, (p.__proto__ || Object.getPrototypeOf(p)).call(this, e)), _this4), _this4.lastValue = !0, _this4.firstRun = !0, _this4.count = 0;return _this4;
        }

        _createClass(p, [{
          key: "reset",
          value: function reset() {
            this.offset = 0, this.lastValue = !0, this.firstRun = !0, this.count = 0;
          }
        }, {
          key: "readValue",
          value: function readValue() {
            if (this.done) return !1;for (; 0 === this.count;) {
              if (this.count = this.readUint53(), this.lastValue = !this.lastValue, 0 === this.count && !this.firstRun) throw new RangeError("Zero-length runs are not allowed");this.firstRun = !1;
            }return this.count -= 1, this.lastValue;
          }
        }, {
          key: "skipValues",
          value: function skipValues(e) {
            for (; e > 0 && !this.done;) {
              if (0 === this.count) {
                if (this.count = this.readUint53(), this.lastValue = !this.lastValue, 0 === this.count && !this.firstRun) throw new RangeError("Zero-length runs are not allowed");this.firstRun = !1;
              }this.count < e ? (e -= this.count, this.count = 0) : (this.count -= e, e = 0);
            }
          }
        }, {
          key: "done",
          get: function get() {
            return 0 === this.count && this.offset === this.buf.byteLength;
          }
        }]);

        return p;
      }(d);

      e.exports = { stringToUtf8: s, utf8ToString: r, hexStringToBytes: o, bytesToHexString: l, Encoder: c, Decoder: d, RLEEncoder: u, RLEDecoder: h, DeltaEncoder: function (_u) {
          _inherits(DeltaEncoder, _u);

          function DeltaEncoder() {
            var _this5;

            _classCallCheck(this, DeltaEncoder);

            (_this5 = _possibleConstructorReturn(this, (DeltaEncoder.__proto__ || Object.getPrototypeOf(DeltaEncoder)).call(this, "int")), _this5), _this5.absoluteValue = 0;return _this5;
          }

          _createClass(DeltaEncoder, [{
            key: "appendValue",
            value: function appendValue(e) {
              var t = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : 1;
              t <= 0 || ("number" == typeof e ? (_get(DeltaEncoder.prototype.__proto__ || Object.getPrototypeOf(DeltaEncoder.prototype), "appendValue", this).call(this, e - this.absoluteValue, 1), this.absoluteValue = e, t > 1 && _get(DeltaEncoder.prototype.__proto__ || Object.getPrototypeOf(DeltaEncoder.prototype), "appendValue", this).call(this, 0, t - 1)) : _get(DeltaEncoder.prototype.__proto__ || Object.getPrototypeOf(DeltaEncoder.prototype), "appendValue", this).call(this, e, t));
            }
          }, {
            key: "copyFrom",
            value: function copyFrom(e) {
              var t = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};
              if (t.sumValues) throw new RangeError("unsupported options for DeltaEncoder.copyFrom()");if (!(e instanceof f)) throw new TypeError("incompatible type of decoder");var n = t.count;if (n > 0 && e.done) throw new RangeError("cannot copy " + n + " values");if (0 === n || e.done) return;var s = e.readValue(),
                  r = 0;if (this.appendValue(s), null === s) {
                if (r = e.count + 1, void 0 !== n && n < r && (r = n), e.count -= r - 1, this.count += r - 1, n > r && e.done) throw new RangeError("cannot copy " + n + " values");if (n === r || e.done) return;0 === e.count && this.appendValue(e.readValue());
              }void 0 !== n && (n -= r + 1);
              var _get$call = _get(DeltaEncoder.prototype.__proto__ || Object.getPrototypeOf(DeltaEncoder.prototype), "copyFrom", this).call(this, e, { count: n, sumValues: !0 }),
                  o = _get$call.nonNullValues,
                  a = _get$call.sum;

              o > 0 && (this.absoluteValue = a, e.absoluteValue = a);
            }
          }]);

          return DeltaEncoder;
        }(u), DeltaDecoder: f, BooleanEncoder: function (_c2) {
          _inherits(BooleanEncoder, _c2);

          function BooleanEncoder() {
            var _this6;

            _classCallCheck(this, BooleanEncoder);

            (_this6 = _possibleConstructorReturn(this, (BooleanEncoder.__proto__ || Object.getPrototypeOf(BooleanEncoder)).call(this)), _this6), _this6.lastValue = !1, _this6.count = 0;return _this6;
          }

          _createClass(BooleanEncoder, [{
            key: "appendValue",
            value: function appendValue(e) {
              var t = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : 1;
              if (!1 !== e && !0 !== e) throw new RangeError("Unsupported value for BooleanEncoder: " + e);t <= 0 || (this.lastValue === e ? this.count += t : (this.appendUint53(this.count), this.lastValue = e, this.count = t));
            }
          }, {
            key: "copyFrom",
            value: function copyFrom(e) {
              var t = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};
              if (!(e instanceof p)) throw new TypeError("incompatible type of decoder");var n = t.count;
              var s = "number" == typeof n ? n : Number.MAX_SAFE_INTEGER;if (n && s > 0 && e.done) throw new RangeError("cannot copy " + n + " values");if (0 === s || e.done) return;this.appendValue(e.readValue()), s--;var r = Math.min(e.count, s);for (this.count += r, e.count -= r, s -= r; s > 0 && !e.done;) {
                if (e.count = e.readUint53(), 0 === e.count) throw new RangeError("Zero-length runs are not allowed");e.lastValue = !e.lastValue, this.appendUint53(this.count);var _t30 = Math.min(e.count, s);this.count = _t30, this.lastValue = e.lastValue, e.count -= _t30, s -= _t30;
              }if (n && s > 0 && e.done) throw new RangeError("cannot copy " + n + " values");
            }
          }, {
            key: "finish",
            value: function finish() {
              this.count > 0 && (this.appendUint53(this.count), this.count = 0);
            }
          }]);

          return BooleanEncoder;
        }(c), BooleanDecoder: p };
    }, "./backend/index.js":
    /*!**************************!*\
      !*** ./backend/index.js ***!
      \**************************/function backendIndexJs(e, t, n) {
      var _n31 = n( /*! ./backend */"./backend/backend.js"),
          s = _n31.init,
          r = _n31.clone,
          o = _n31.free,
          a = _n31.applyChanges,
          i = _n31.applyLocalChange,
          l = _n31.save,
          c = _n31.load,
          d = _n31.loadChanges,
          u = _n31.getPatch,
          h = _n31.getHeads,
          f = _n31.getAllChanges,
          p = _n31.getChanges,
          b = _n31.getChangesAdded,
          g = _n31.getChangeByHash,
          m = _n31.getMissingDeps,
          _n32 = n( /*! ./sync */"./backend/sync.js"),
          y = _n32.receiveSyncMessage,
          w = _n32.generateSyncMessage,
          _ = _n32.encodeSyncMessage,
          I = _n32.decodeSyncMessage,
          v = _n32.encodeSyncState,
          k = _n32.decodeSyncState,
          x = _n32.initSyncState;

      e.exports = { init: s, clone: r, free: o, applyChanges: a, applyLocalChange: i, save: l, load: c, loadChanges: d, getPatch: u, getHeads: h, getAllChanges: f, getChanges: p, getChangesAdded: b, getChangeByHash: g, getMissingDeps: m, receiveSyncMessage: y, generateSyncMessage: w, encodeSyncMessage: _, decodeSyncMessage: I, encodeSyncState: v, decodeSyncState: k, initSyncState: x };
    }, "./backend/new.js":
    /*!************************!*\
      !*** ./backend/new.js ***!
      \************************/function backendNewJs(e, t, n) {
      var _n33 = n( /*! ../src/common */"./src/common.js"),
          s = _n33.parseOpId,
          r = _n33.copyObject,
          _n34 = n( /*! ./columnar */"./backend/columnar.js"),
          o = _n34.COLUMN_TYPE,
          a = _n34.VALUE_TYPE,
          i = _n34.ACTIONS,
          l = _n34.OBJECT_TYPE,
          c = _n34.DOC_OPS_COLUMNS,
          d = _n34.CHANGE_COLUMNS,
          u = _n34.DOCUMENT_COLUMNS,
          h = _n34.encoderByColumnId,
          f = _n34.decoderByColumnId,
          p = _n34.makeDecoders,
          b = _n34.decodeValue,
          g = _n34.encodeChange,
          m = _n34.decodeChangeColumns,
          y = _n34.decodeChangeMeta,
          w = _n34.decodeChanges,
          _ = _n34.decodeDocumentHeader,
          I = _n34.encodeDocumentHeader,
          v = 600,
          k = Math.floor(750),
          x = d.filter(function (e) {
        return ["predNum", "predActor", "predCtr"].includes(e.columnName);
      }).map(function (e) {
        return e.columnId;
      });

      function j(e, t, n) {
        if (1 === t.length) e[t[0]] = n;else {
          var _s18 = Object.assign({}, e[t[0]]);j(_s18, t.slice(1), n), e[t[0]] = _s18;
        }
      }function E(e, t, n, s) {
        var _iteratorNormalCompletion32 = true;
        var _didIteratorError32 = false;
        var _iteratorError32 = undefined;

        try {
          for (var _iterator32 = t[Symbol.iterator](), _step32; !(_iteratorNormalCompletion32 = (_step32 = _iterator32.next()).done); _iteratorNormalCompletion32 = true) {
            var _e35 = _step32.value;
            _e35.decoder.reset();
          }
        } catch (err) {
          _didIteratorError32 = true;
          _iteratorError32 = err;
        } finally {
          try {
            if (!_iteratorNormalCompletion32 && _iterator32.return) {
              _iterator32.return();
            }
          } finally {
            if (_didIteratorError32) {
              throw _iteratorError32;
            }
          }
        }

        var r = e.objActor,
            o = e.objCtr,
            a = e.keyActor,
            i = e.keyCtr,
            l = e.keyStr,
            c = e.idActor,
            d = e.idCtr,
            u = e.insert,
            _t$map = t.map(function (e) {
          return e.decoder;
        }),
            _t$map2 = _slicedToArray(_t$map, 14),
            h = _t$map2[0],
            f = _t$map2[1],
            p = _t$map2[4],
            b = _t$map2[5],
            g = _t$map2[6],
            m = _t$map2[7],
            y = _t$map2[8],
            w = _t$map2[13];

        var _ = 0,
            I = 0,
            v = !1,
            k = null,
            x = null,
            j = null,
            E = null,
            O = null,
            A = null,
            R = 0;if (null !== o && !s) for (; (!f.done || !h.done || !y.done) && (x = f.readValue(), k = n[h.readValue()], y.skipValues(1), null === x || !k || x < o || x === o && k < r);) {
          _ += 1;
        }if ((x !== o || k !== r) && !s) return { found: !0, skipCount: _, visibleCount: I };if (null !== l) {
          for (p.skipValues(_); !p.done;) {
            var _e36 = h.readValue();if (k = null === _e36 ? null : n[_e36], x = f.readValue(), O = p.readValue(), !(null !== O && O < l && x === o && k === r)) break;_ += 1;
          }return { found: !0, skipCount: _, visibleCount: I };
        }if (g.skipValues(_), b.skipValues(_), m.skipValues(_), w.skipValues(_), E = g.readValue(), j = n[b.readValue()], A = m.readValue(), R = w.readValue(), u) {
          if (!s && null !== i && i > 0 && null !== a) {
            for (_ += 1; !(g.done || b.done || E === i && j === a) && (A && (v = !1), 0 !== R || v || (I += 1, v = !0), E = g.readValue(), j = n[b.readValue()], x = f.readValue(), k = n[h.readValue()], A = m.readValue(), R = w.readValue(), x === o && k === r);) {
              _ += 1;
            }if (x !== o || k !== r || E !== i || j !== a || !A) return { found: !1, skipCount: _, visibleCount: I };if (A && (v = !1), 0 !== R || v || (I += 1, v = !0), g.done || b.done) return { found: !0, skipCount: _, visibleCount: I };E = g.readValue(), j = n[b.readValue()], x = f.readValue(), k = n[h.readValue()], A = m.readValue(), R = w.readValue();
          }for (; (!A || E > d || E === d && j > c) && x === o && k === r && (_ += 1, A && (v = !1), 0 !== R || v || (I += 1, v = !0), !g.done && !b.done);) {
            E = g.readValue(), j = n[b.readValue()], x = f.readValue(), k = n[h.readValue()], A = m.readValue(), R = w.readValue();
          }
        } else if (null !== i && i > 0 && null !== a) {
          for (; !(A && E === i && j === a || x !== o || k !== r || (_ += 1, A && (v = !1), 0 !== R || v || (I += 1, v = !0), g.done || b.done));) {
            E = g.readValue(), j = n[b.readValue()], x = f.readValue(), k = n[h.readValue()], A = m.readValue(), R = w.readValue();
          }if (x !== o || k !== r || E !== i || j !== a || !A) return { found: !1, skipCount: _, visibleCount: I };
        }return { found: !0, skipCount: _, visibleCount: I };
      }function O(e, t, n, s) {
        var r = e.blocks[t],
            o = e.blocks[t + 1];return r.lastObjectActor !== n || r.lastObjectCtr !== s || void 0 === r.numVisible ? 0 : r.lastVisibleActor === o.firstVisibleActor && void 0 !== r.lastVisibleActor && r.lastVisibleCtr === o.firstVisibleCtr && void 0 !== r.lastVisibleCtr ? r.numVisible - 1 : r.numVisible;
      }function A(e, t) {
        var n = t.objActor,
            s = t.objActorNum,
            r = t.objCtr,
            o = t.keyActor,
            a = t.keyCtr,
            i = t.keyStr;
        var l = 0,
            c = 0;if (null !== r) for (; l < e.blocks.length - 1;) {
          var _t31 = void 0 === e.blocks[l].lastObjectActor ? void 0 : e.actorIds[e.blocks[l].lastObjectActor],
              _s19 = e.blocks[l].lastObjectCtr;if (!(null === _s19 || _s19 < r || _s19 === r && _t31 < n)) break;l++;
        }if (null !== i) {
          for (; l < e.blocks.length - 1;) {
            var _e$blocks$l = e.blocks[l],
                _t32 = _e$blocks$l.lastObjectActor,
                _n36 = _e$blocks$l.lastObjectCtr,
                _o10 = _e$blocks$l.lastKey;
            if (!(r === _n36 && s === _t32 && void 0 !== _o10 && _o10 < i)) break;l++;
          }
          var _E = E(t, e.blocks[l].columns, e.actorIds, !1),
              _n35 = _E.skipCount;

          return { blockIndex: l, skipCount: _n35, visibleCount: 0 };
        }{
          var _n37 = null === a || 0 === a || null === o,
              _i5 = null === o ? null : e.actorIds.indexOf(o);var _d3 = !1;for (;;) {
            if (!_n37 && !_d3) for (; l < e.blocks.length - 1 && e.blocks[l].lastObjectActor === s && e.blocks[l].lastObjectCtr === r && !C(e.blocks[l].bloom, _i5, a);) {
              if (e.blocks[l].lastObjectCtr > r) throw new RangeError("Reference element not found: " + a + "@" + o);c += O(e, l, s, r), l++;
            }
            var _E2 = E(t, e.blocks[l].columns, e.actorIds, _d3),
                _u2 = _E2.found,
                _h2 = _E2.skipCount,
                _f = _E2.visibleCount;

            if (l === e.blocks.length - 1 || e.blocks[l].lastObjectActor !== s || e.blocks[l].lastObjectCtr !== r) {
              if (_u2) return { blockIndex: l, skipCount: _h2, visibleCount: c + _f };throw new RangeError("Reference element not found: " + a + "@" + o);
            }if (_u2 && _h2 < e.blocks[l].numOps) return { blockIndex: l, skipCount: _h2, visibleCount: c + _f };_d3 = _u2 && t.insert, c += O(e, l, s, r), l++;
          }
        }
      }function R(e, t, n) {
        var s = 8 * e.byteLength,
            r = n % s,
            o = t % s,
            a = (16777619 * (n ^ t) >>> 0) % s;for (var _t33 = 0; _t33 < 7; _t33++) {
          e[r >>> 3] |= 1 << (7 & r), r = (r + o) % s, o = (o + a) % s;
        }
      }function C(e, t, n) {
        var s = 8 * e.byteLength,
            r = n % s,
            o = t % s,
            a = (16777619 * (n ^ t) >>> 0) % s;for (var _t34 = 0; _t34 < 7; _t34++) {
          if (0 == (e[r >>> 3] & 1 << (7 & r))) return !1;r = (r + o) % s, o = (o + a) % s;
        }return !0;
      }function V(e) {
        e.bloom = new Uint8Array(k), e.numOps = 0, e.lastKey = void 0, e.numVisible = void 0, e.lastObjectActor = void 0, e.lastObjectCtr = void 0, e.firstVisibleActor = void 0, e.firstVisibleCtr = void 0, e.lastVisibleActor = void 0, e.lastVisibleCtr = void 0;var _iteratorNormalCompletion33 = true;
        var _didIteratorError33 = false;
        var _iteratorError33 = undefined;

        try {
          for (var _iterator33 = e.columns[Symbol.iterator](), _step33; !(_iteratorNormalCompletion33 = (_step33 = _iterator33.next()).done); _iteratorNormalCompletion33 = true) {
            var _t35 = _step33.value;
            _t35.decoder.reset();
          }
        } catch (err) {
          _didIteratorError33 = true;
          _iteratorError33 = err;
        } finally {
          try {
            if (!_iteratorNormalCompletion33 && _iterator33.return) {
              _iterator33.return();
            }
          } finally {
            if (_didIteratorError33) {
              throw _iteratorError33;
            }
          }
        }

        var _e$columns$map = e.columns.map(function (e) {
          return e.decoder;
        }),
            _e$columns$map2 = _slicedToArray(_e$columns$map, 14),
            t = _e$columns$map2[0],
            n = _e$columns$map2[1],
            s = _e$columns$map2[2],
            r = _e$columns$map2[3],
            o = _e$columns$map2[4],
            a = _e$columns$map2[5],
            i = _e$columns$map2[6],
            l = _e$columns$map2[7],
            c = _e$columns$map2[13];

        for (; !i.done;) {
          e.numOps += 1;var _d4 = t.readValue(),
              _u3 = n.readValue(),
              _h3 = s.readValue(),
              _f2 = r.readValue(),
              _p = o.readValue(),
              _b = a.readValue(),
              _g = i.readValue(),
              _m = l.readValue(),
              _y = c.readValue();if (e.lastObjectActor === _d4 && e.lastObjectCtr === _u3 || (e.numVisible = 0, e.lastObjectActor = _d4, e.lastObjectCtr = _u3), null !== _p) e.lastKey = _p;else if (_m || null !== _f2) {
            e.lastKey = void 0;var _t36 = _m ? _b : _h3,
                _n38 = _m ? _g : _f2;R(e.bloom, _t36, _n38), 0 === _y && (void 0 === e.firstVisibleActor && (e.firstVisibleActor = _t36), void 0 === e.firstVisibleCtr && (e.firstVisibleCtr = _n38), e.lastVisibleActor === _t36 && e.lastVisibleCtr === _n38 || (e.numVisible += 1, e.lastVisibleActor = _t36, e.lastVisibleCtr = _n38));
          }
        }
      }function S(e, t, n, s) {
        if (null !== t[4]) e.lastObjectCtr === t[1] && e.lastObjectActor === t[0] && (void 0 === e.lastKey || e.lastKey < t[4]) && (e.lastKey = t[4]);else {
          var _n39 = t[7] ? t[5] : t[2],
              _r11 = t[7] ? t[6] : t[3];R(e.bloom, _n39, _r11), (0 === t[13] || s) && (void 0 === e.firstVisibleActor && (e.firstVisibleActor = _n39), void 0 === e.firstVisibleCtr && (e.firstVisibleCtr = _r11), e.lastVisibleActor = _n39, e.lastVisibleCtr = _r11);
        }(void 0 === e.lastObjectCtr || null !== t[0] && null !== t[1] && (null === e.lastObjectCtr || e.lastObjectCtr < t[1] || e.lastObjectCtr === t[1] && n[e.lastObjectActor] < n[t[0]])) && (e.lastObjectActor = t[0], e.lastObjectCtr = t[1], e.lastKey = null !== t[4] ? t[4] : void 0, e.numVisible = 0);
      }function N(e) {
        var _iteratorNormalCompletion34 = true;
        var _didIteratorError34 = false;
        var _iteratorError34 = undefined;

        try {
          for (var _iterator34 = e.columns[Symbol.iterator](), _step34; !(_iteratorNormalCompletion34 = (_step34 = _iterator34.next()).done); _iteratorNormalCompletion34 = true) {
            var _t37 = _step34.value;
            _t37.decoder.reset();
          }
        } catch (err) {
          _didIteratorError34 = true;
          _iteratorError34 = err;
        } finally {
          try {
            if (!_iteratorNormalCompletion34 && _iterator34.return) {
              _iterator34.return();
            }
          } finally {
            if (_didIteratorError34) {
              throw _iteratorError34;
            }
          }
        }

        var t = Math.ceil(e.numOps / 480);var n = [],
            s = 0;for (var _r12 = 1; _r12 <= t; _r12++) {
          var _o11 = Math.ceil(_r12 * e.numOps / t) - s,
              _a7 = e.columns.map(function (e) {
            return { columnId: e.columnId, encoder: h(e.columnId) };
          });U(_a7, e.columns, _o11);var _i6 = { columns: _a7.map(function (e) {
              var t = f(e.columnId, e.encoder.buffer);return { columnId: e.columnId, decoder: t };
            }) };V(_i6), n.push(_i6), s += _o11;
        }return n;
      }function T(e) {
        var t = e[0].columns.map(function (e) {
          return { columnId: e.columnId, encoder: h(e.columnId) };
        });var _iteratorNormalCompletion35 = true;
        var _didIteratorError35 = false;
        var _iteratorError35 = undefined;

        try {
          for (var _iterator35 = e[Symbol.iterator](), _step35; !(_iteratorNormalCompletion35 = (_step35 = _iterator35.next()).done); _iteratorNormalCompletion35 = true) {
            var _n40 = _step35.value;
            var _iteratorNormalCompletion36 = true;
            var _didIteratorError36 = false;
            var _iteratorError36 = undefined;

            try {
              for (var _iterator36 = _n40.columns[Symbol.iterator](), _step36; !(_iteratorNormalCompletion36 = (_step36 = _iterator36.next()).done); _iteratorNormalCompletion36 = true) {
                var _e37 = _step36.value;
                _e37.decoder.reset();
              }
            } catch (err) {
              _didIteratorError36 = true;
              _iteratorError36 = err;
            } finally {
              try {
                if (!_iteratorNormalCompletion36 && _iterator36.return) {
                  _iterator36.return();
                }
              } finally {
                if (_didIteratorError36) {
                  throw _iteratorError36;
                }
              }
            }

            U(t, _n40.columns, _n40.numOps);
          }
        } catch (err) {
          _didIteratorError35 = true;
          _iteratorError35 = err;
        } finally {
          try {
            if (!_iteratorNormalCompletion35 && _iterator35.return) {
              _iterator35.return();
            }
          } finally {
            if (_didIteratorError35) {
              throw _iteratorError35;
            }
          }
        }

        return t;
      }function U(e, t, n) {
        if (0 === n) return;var s = 0,
            r = -1,
            a = 0,
            i = -1,
            l = 0;var _iteratorNormalCompletion37 = true;
        var _didIteratorError37 = false;
        var _iteratorError37 = undefined;

        try {
          for (var _iterator37 = e[Symbol.iterator](), _step37; !(_iteratorNormalCompletion37 = (_step37 = _iterator37.next()).done); _iteratorNormalCompletion37 = true) {
            var _c3 = _step37.value;
            for (; s < t.length && t[s].columnId < _c3.columnId;) {
              s++;
            }var _e38 = null;s < t.length && t[s].columnId === _c3.columnId && t[s].decoder.buf.byteLength > 0 && (_e38 = t[s].decoder);var _d5 = _c3.columnId >> 4 === r ? a : n;if (_c3.columnId % 8 === o.GROUP_CARD) r = _c3.columnId >> 4, _e38 ? a = _c3.encoder.copyFrom(_e38, { count: n, sumValues: !0 }).sum : (_c3.encoder.appendValue(0, n), a = 0);else if (_c3.columnId % 8 === o.VALUE_LEN) {
              if (_e38) {
                if (s + 1 === t.length || t[s + 1].columnId !== _c3.columnId + 1) throw new RangeError("VALUE_LEN column without accompanying VALUE_RAW column");i = _c3.columnId + 1, l = _c3.encoder.copyFrom(_e38, { count: _d5, sumValues: !0, sumShift: 4 }).sum;
              } else _c3.encoder.appendValue(null, _d5), i = _c3.columnId + 1, l = 0;
            } else if (_c3.columnId % 8 === o.VALUE_RAW) {
              if (_c3.columnId !== i) throw new RangeError("VALUE_RAW column without accompanying VALUE_LEN column");l > 0 && _c3.encoder.appendRawBytes(_e38.readRawBytes(l));
            } else if (_e38) _c3.encoder.copyFrom(_e38, { count: _d5 });else {
              var _e39 = _c3.columnId % 8 !== o.BOOLEAN && null;_c3.encoder.appendValue(_e39, _d5);
            }
          }
        } catch (err) {
          _didIteratorError37 = true;
          _iteratorError37 = err;
        } finally {
          try {
            if (!_iteratorNormalCompletion37 && _iterator37.return) {
              _iterator37.return();
            }
          } finally {
            if (_didIteratorError37) {
              throw _iteratorError37;
            }
          }
        }
      }function L(e, t) {
        var n = void 0,
            s = [],
            r = -1,
            a = 0,
            i = -1,
            l = 0;var _iteratorNormalCompletion38 = true;
        var _didIteratorError38 = false;
        var _iteratorError38 = undefined;

        try {
          for (var _iterator38 = e[Symbol.iterator](), _step38; !(_iteratorNormalCompletion38 = (_step38 = _iterator38.next()).done); _iteratorNormalCompletion38 = true) {
            var _c4 = _step38.value;
            if (_c4.columnId % 8 === o.VALUE_RAW) {
              if (_c4.columnId !== i) throw new RangeError("unexpected VALUE_RAW column");n = _c4.decoder.readRawBytes(l);
            } else if (_c4.columnId % 8 === o.GROUP_CARD) r = _c4.columnId >> 4, a = _c4.decoder.readValue() || 0, n = a;else if (_c4.columnId >> 4 === r) {
              n = [], _c4.columnId % 8 === o.VALUE_LEN && (i = _c4.columnId + 1, l = 0);for (var _e40 = 0; _e40 < a; _e40++) {
                var _e41 = _c4.decoder.readValue();_c4.columnId % 8 === o.ACTOR_ID && t && "number" == typeof _e41 && (_e41 = t[_e41]), _c4.columnId % 8 === o.VALUE_LEN && (l += n >>> 4), n.push(_e41);
              }
            } else n = _c4.decoder.readValue(), _c4.columnId % 8 === o.ACTOR_ID && t && "number" == typeof n && (n = t[n]), _c4.columnId % 8 === o.VALUE_LEN && (i = _c4.columnId + 1, l = n >>> 4);s.push(n);
          }
        } catch (err) {
          _didIteratorError38 = true;
          _iteratorError38 = err;
        } finally {
          try {
            if (!_iteratorNormalCompletion38 && _iterator38.return) {
              _iterator38.return();
            }
          } finally {
            if (_didIteratorError38) {
              throw _iteratorError38;
            }
          }
        }

        return s;
      }function B(e, t, n) {
        var s = 0,
            r = -1,
            a = 0;var _iteratorNormalCompletion39 = true;
        var _didIteratorError39 = false;
        var _iteratorError39 = undefined;

        try {
          for (var _iterator39 = e[Symbol.iterator](), _step39; !(_iteratorNormalCompletion39 = (_step39 = _iterator39.next()).done); _iteratorNormalCompletion39 = true) {
            var _i7 = _step39.value;
            for (; s < t.length && t[s].columnId < _i7.columnId;) {
              s++;
            }if (s < t.length && t[s].columnId === _i7.columnId) {
              var _e42 = n[s];if (_i7.columnId % 8 === o.GROUP_CARD) r = _i7.columnId >> 4, a = _e42, _i7.encoder.appendValue(_e42);else if (_i7.columnId >> 4 === r) {
                if (!Array.isArray(_e42) || _e42.length !== a) throw new RangeError("bad group value");var _iteratorNormalCompletion40 = true;
                var _didIteratorError40 = false;
                var _iteratorError40 = undefined;

                try {
                  for (var _iterator40 = _e42[Symbol.iterator](), _step40; !(_iteratorNormalCompletion40 = (_step40 = _iterator40.next()).done); _iteratorNormalCompletion40 = true) {
                    var _t38 = _step40.value;
                    _i7.encoder.appendValue(_t38);
                  }
                } catch (err) {
                  _didIteratorError40 = true;
                  _iteratorError40 = err;
                } finally {
                  try {
                    if (!_iteratorNormalCompletion40 && _iterator40.return) {
                      _iterator40.return();
                    }
                  } finally {
                    if (_didIteratorError40) {
                      throw _iteratorError40;
                    }
                  }
                }
              } else _i7.columnId % 8 === o.VALUE_RAW ? _e42 && _i7.encoder.appendRawBytes(_e42) : _i7.encoder.appendValue(_e42);
            } else if (_i7.columnId % 8 === o.GROUP_CARD) r = _i7.columnId >> 4, a = 0, _i7.encoder.appendValue(0);else if (_i7.columnId % 8 !== o.VALUE_RAW) {
              var _e43 = _i7.columnId >> 4 === r ? a : 1;var _t39 = null;_i7.columnId % 8 === o.BOOLEAN && (_t39 = !1), _i7.columnId % 8 === o.VALUE_LEN && (_t39 = 0), _i7.encoder.appendValue(_t39, _e43);
            }
          }
        } catch (err) {
          _didIteratorError39 = true;
          _iteratorError39 = err;
        } finally {
          try {
            if (!_iteratorNormalCompletion39 && _iterator39.return) {
              _iterator39.return();
            }
          } finally {
            if (_didIteratorError39) {
              throw _iteratorError39;
            }
          }
        }
      }function z(e, t) {
        var n = e.blocks[t];if (n.columns[8].decoder.done) {
          if (t === e.blocks.length - 1) return { docOp: null, blockIndex: t };t += 1, n = e.blocks[t];var _iteratorNormalCompletion41 = true;
          var _didIteratorError41 = false;
          var _iteratorError41 = undefined;

          try {
            for (var _iterator41 = n.columns[Symbol.iterator](), _step41; !(_iteratorNormalCompletion41 = (_step41 = _iterator41.next()).done); _iteratorNormalCompletion41 = true) {
              var _e44 = _step41.value;
              _e44.decoder.reset();
            }
          } catch (err) {
            _didIteratorError41 = true;
            _iteratorError41 = err;
          } finally {
            try {
              if (!_iteratorNormalCompletion41 && _iterator41.return) {
                _iterator41.return();
              }
            } finally {
              if (_didIteratorError41) {
                throw _iteratorError41;
              }
            }
          }

          return { docOp: L(n.columns), blockIndex: t };
        }return { docOp: L(n.columns), blockIndex: t };
      }function D(e, t) {
        for (; t.changeIndex < t.changes.length - 1 && (!t.columns || t.columns[8].decoder.done);) {
          t.changeIndex += 1;var _n41 = t.changes[t.changeIndex];t.columns = p(_n41.columns, d), t.opCtr = _n41.startOp, t.columns[8].decoder.done && (_n41.maxOp = _n41.startOp - 1), Z(e, t.columns);
          var _G = G(e.actorIds, _n41),
              _s20 = _G.actorIds,
              _r13 = _G.actorTable;

          e.actorIds = _s20, t.actorTable = _r13, t.actorIndex = e.actorIds.indexOf(_n41.actorIds[0]);
        }if (t.columns[8].decoder.done) return t.done = !0, void (t.nextOp = null);t.nextOp = L(t.columns, t.actorTable), t.nextOp[5] = t.actorIndex, t.nextOp[6] = t.opCtr, t.changes[t.changeIndex].maxOp = t.opCtr, t.opCtr > e.maxOp && (e.maxOp = t.opCtr), t.opCtr += 1;var n = t.nextOp;if (null === n[1] && null !== n[0] || null !== n[1] && null === n[0]) throw new RangeError("Mismatched object reference: (" + n[1] + ", " + n[0] + ")");if (null === n[3] && null !== n[2] || 0 === n[3] && null !== n[2] || n[3] > 0 && null === n[2]) throw new RangeError("Mismatched operation key: (" + n[3] + ", " + n[2] + ")");
      }function H(e, t) {
        return "list" === t || "text" === t ? { objectId: e, type: t, edits: [] } : { objectId: e, type: t, props: {} };
      }function $(e, t) {
        var n = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : 1;
        var r = s(e),
            o = s(t);return r.actorId === o.actorId && r.counter + n === o.counter;
      }function M(e, t) {
        if (0 === e.length) return void e.push(t);var n = e[e.length - 1];"insert" === n.action && "insert" === t.action && n.index === t.index - 1 && "value" === n.value.type && "value" === t.value.type && n.elemId === n.opId && t.elemId === t.opId && $(n.elemId, t.elemId, 1) && n.value.datatype === t.value.datatype && _typeof(n.value.value) == _typeof(t.value.value) ? (n.action = "multi-insert", t.value.datatype && (n.datatype = t.value.datatype), n.values = [n.value.value, t.value.value], delete n.value, delete n.opId) : "multi-insert" === n.action && "insert" === t.action && n.index + n.values.length === t.index && "value" === t.value.type && t.elemId === t.opId && $(n.elemId, t.elemId, n.values.length) && n.datatype === t.value.datatype && _typeof(n.values[0]) == _typeof(t.value.value) ? n.values.push(t.value.value) : "remove" === n.action && "remove" === t.action && n.index === t.index ? n.count += t.count : e.push(t);
      }function P(e, t, n, s, r, o) {
        var a = !1;if (o) for (; !a && e.length > 0;) {
          var _n42 = e[e.length - 1];if ("insert" !== _n42.action && "update" !== _n42.action || _n42.index !== t) {
            if ("multi-insert" !== _n42.action || _n42.index + _n42.values.length - 1 !== t) break;_n42.values.pop(), a = !0;
          } else e.pop(), a = "insert" === _n42.action;
        }M(e, a ? { action: "insert", index: t, elemId: n, opId: s, value: r } : { action: "update", index: t, opId: s, value: r });
      }function F(e, t, n, s, r, o, c, d) {
        var u = !t,
            h = s[8] < i.length ? l[i[s[8]]] : null,
            f = s[6] + "@" + r.actorIds[s[5]],
            p = s[7] ? s[5] : s[2],
            g = s[7] ? s[6] : s[3],
            m = s[4] ? s[4] : g + "@" + r.actorIds[p];s[8] % 2 != 0 || r.objectMeta[f] || (r.objectMeta[f] = { parentObj: n, parentKey: m, opId: f, type: h, children: {} }, j(r.objectMeta, [n, "children", m, f], { objectId: f, type: h, props: {} }));var y = !o[m];o[m] || (o[m] = { visibleOps: [], hasChild: !1 });var w = void 0 !== d && s[13] > 0;w || (o[m].visibleOps.push(s), o[m].hasChild = o[m].hasChild || s[8] % 2 == 0);var _ = r.objectMeta[n].children[m];if (o[m].hasChild || _ && Object.keys(_).length > 0) {
          var _e45 = {};var _iteratorNormalCompletion42 = true;
          var _didIteratorError42 = false;
          var _iteratorError42 = undefined;

          try {
            for (var _iterator42 = o[m].visibleOps[Symbol.iterator](), _step42; !(_iteratorNormalCompletion42 = (_step42 = _iterator42.next()).done); _iteratorNormalCompletion42 = true) {
              var _t40 = _step42.value;
              var _n43 = _t40[6] + "@" + r.actorIds[_t40[5]];if ("set" === i[_t40[8]]) _e45[_n43] = Object.assign({ type: "value" }, b(_t40[9], _t40[10]));else if (_t40[8] % 2 == 0) {
                var _s21 = _t40[8] < i.length ? l[i[_t40[8]]] : null;_e45[_n43] = H(_n43, _s21);
              }
            }
          } catch (err) {
            _didIteratorError42 = true;
            _iteratorError42 = err;
          } finally {
            try {
              if (!_iteratorNormalCompletion42 && _iterator42.return) {
                _iterator42.return();
              }
            } finally {
              if (_didIteratorError42) {
                throw _iteratorError42;
              }
            }
          }

          j(r.objectMeta, [n, "children", m], _e45);
        }var I = void 0,
            v = void 0;if (w && "set" === i[s[8]] && (15 & s[9]) === a.COUNTER) {
          o[m] || (o[m] = { visibleOps: [], hasChild: !1 }), o[m].counterStates || (o[m].counterStates = {});var _e46 = o[m].counterStates,
              _t41 = { opId: f, value: b(s[9], s[10]).value, succs: {} };for (var _n44 = 0; _n44 < s[13]; _n44++) {
            var _o12 = s[15][_n44] + "@" + r.actorIds[s[14][_n44]];_e46[_o12] = _t41, _t41.succs[_o12] = !0;
          }
        } else if ("inc" === i[s[8]]) {
          if (!o[m] || !o[m].counterStates || !o[m].counterStates[f]) throw new RangeError("increment operation " + f + " for unknown counter");var _e47 = o[m].counterStates[f];_e47.value += b(s[9], s[10]).value, delete _e47.succs[f], 0 === Object.keys(_e47.succs).length && (I = _e47.opId, v = { type: "value", datatype: "counter", value: _e47.value });
        } else w || ("set" === i[s[8]] ? (I = f, v = Object.assign({ type: "value" }, b(s[9], s[10]))) : s[8] % 2 == 0 && (e[f] || (e[f] = H(f, h)), I = f, v = e[f]));e[n] || (e[n] = H(n, r.objectMeta[n].type));var k = e[n];if (null === s[4]) {
          if (0 !== d || u || "insert" !== o[m].action || (o[m].action = "update", function (e, t, n) {
            var s = [];for (; e.length > 0;) {
              var _n45 = e[e.length - 1];if ("insert" === _n45.action) {
                if (_n45.index !== t) throw new RangeError("last edit has unexpected index");s.unshift(e.pop());break;
              }if ("update" !== _n45.action) throw new RangeError("last edit has unexpected action");if (_n45.index !== t) throw new RangeError("last edit has unexpected index");s.unshift(e.pop());
            }var r = !0;var _iteratorNormalCompletion43 = true;
            var _didIteratorError43 = false;
            var _iteratorError43 = undefined;

            try {
              for (var _iterator43 = s[Symbol.iterator](), _step43; !(_iteratorNormalCompletion43 = (_step43 = _iterator43.next()).done); _iteratorNormalCompletion43 = true) {
                var _o13 = _step43.value;
                P(e, t, n, _o13.opId, _o13.value, r), r = !1;
              }
            } catch (err) {
              _didIteratorError43 = true;
              _iteratorError43 = err;
            } finally {
              try {
                if (!_iteratorNormalCompletion43 && _iterator43.return) {
                  _iterator43.return();
                }
              } finally {
                if (_didIteratorError43) {
                  throw _iteratorError43;
                }
              }
            }
          }(k.edits, c, m), t && t.lastObjectActor === s[0] && t.lastObjectCtr === s[1] && (t.numVisible -= 1)), v) {
            if (o[m].action || void 0 !== d && !u) {
              if ("remove" === o[m].action) {
                var _e48 = k.edits[k.edits.length - 1];if ("remove" !== _e48.action) throw new RangeError("last edit has unexpected type");_e48.count > 1 ? _e48.count -= 1 : k.edits.pop(), o[m].action = "update", P(k.edits, c, m, I, v, !0), t && t.lastObjectActor === s[0] && t.lastObjectCtr === s[1] && (t.numVisible += 1);
              } else P(k.edits, c, m, I, v, !o[m].action), o[m].action || (o[m].action = "update");
            } else o[m].action = "insert", M(k.edits, { action: "insert", index: c, elemId: m, opId: I, value: v }), t && t.lastObjectActor === s[0] && t.lastObjectCtr === s[1] && (t.numVisible += 1);
          } else 0 !== d || o[m].action || (o[m].action = "remove", M(k.edits, { action: "remove", index: c, count: 1 }), t && t.lastObjectActor === s[0] && t.lastObjectCtr === s[1] && (t.numVisible -= 1));
        } else !v && u || (!y && k.props[s[4]] || (k.props[s[4]] = {}), v && (k.props[s[4]][I] = v));
      }function q(e, t, n) {
        var _t$nextOp = _slicedToArray(t.nextOp, 8),
            s = _t$nextOp[0],
            r = _t$nextOp[1],
            o = _t$nextOp[2],
            a = _t$nextOp[3],
            l = _t$nextOp[4],
            c = _t$nextOp[5],
            d = _t$nextOp[6],
            u = _t$nextOp[7],
            p = null === s ? null : n.actorIds[s],
            b = { objActor: p, objActorNum: s, objCtr: r, keyActor: null === o ? null : n.actorIds[o], keyActorNum: o, keyCtr: a, keyStr: l, idActor: n.actorIds[c], idCtr: d, insert: u, objId: null === p ? "_root" : r + "@" + p },
            _A = A(n, b),
            g = _A.blockIndex,
            m = _A.skipCount,
            y = _A.visibleCount,
            w = n.blocks[g];

        var _iteratorNormalCompletion44 = true;
        var _didIteratorError44 = false;
        var _iteratorError44 = undefined;

        try {
          for (var _iterator44 = w.columns[Symbol.iterator](), _step44; !(_iteratorNormalCompletion44 = (_step44 = _iterator44.next()).done); _iteratorNormalCompletion44 = true) {
            var _e49 = _step44.value;
            _e49.decoder.reset();
          }
        } catch (err) {
          _didIteratorError44 = true;
          _iteratorError44 = err;
        } finally {
          try {
            if (!_iteratorNormalCompletion44 && _iterator44.return) {
              _iterator44.return();
            }
          } finally {
            if (_didIteratorError44) {
              throw _iteratorError44;
            }
          }
        }

        var _ = 0 === m || void 0 === w.firstVisibleActor || !u && w.firstVisibleActor === o && w.firstVisibleCtr === a,
            I = { columns: void 0, bloom: new Uint8Array(w.bloom), numOps: m, lastKey: w.lastKey, numVisible: w.numVisible, lastObjectActor: w.lastObjectActor, lastObjectCtr: w.lastObjectCtr, firstVisibleActor: _ ? void 0 : w.firstVisibleActor, firstVisibleCtr: _ ? void 0 : w.firstVisibleCtr, lastVisibleActor: void 0, lastVisibleCtr: void 0 },
            k = w.columns.map(function (e) {
          return { columnId: e.columnId, encoder: h(e.columnId) };
        });U(k, w.columns, m);
        var _ref5 = function (e, t, n, s, r, o, a) {
          var l = s.nextOp,
              c = l[7],
              d = l[0],
              u = l[1],
              h = null === d ? "_root" : u + "@" + r.actorIds[d],
              f = s.actorIndex,
              p = r.actorIds[f];var b = void 0,
              g = !1,
              m = !1,
              y = {};
          var _z = z(r, a);

          b = _z.docOp;
          a = _z.blockIndex;
          var w = null === b ? 0 : 1,
              _ = null === b ? 0 : b[13],
              I = null,
              v = [],
              k = [],
              x = [],
              j = null;for (s.objectIds.add(h);;) {
            var _z2;

            if (0 === v.length) {
              g = !1;var _e50 = s.nextOp;for (; !s.done && _e50[5] === f && _e50[7] === c && _e50[0] === l[0] && _e50[1] === l[1];) {
                var _t42 = v.length > 0 ? v[v.length - 1] : null;var _n46 = !1;for (var _t43 = 0; _t43 < _e50[13]; _t43++) {
                  var _iteratorNormalCompletion45 = true;
                  var _didIteratorError45 = false;
                  var _iteratorError45 = undefined;

                  try {
                    for (var _iterator45 = v[Symbol.iterator](), _step45; !(_iteratorNormalCompletion45 = (_step45 = _iterator45.next()).done); _iteratorNormalCompletion45 = true) {
                      var _s22 = _step45.value;
                      _e50[14][_t43] === _s22[5] && _e50[15][_t43] === _s22[6] && (_n46 = !0);
                    }
                  } catch (err) {
                    _didIteratorError45 = true;
                    _iteratorError45 = err;
                  } finally {
                    try {
                      if (!_iteratorNormalCompletion45 && _iterator45.return) {
                        _iterator45.return();
                      }
                    } finally {
                      if (_didIteratorError45) {
                        throw _iteratorError45;
                      }
                    }
                  }
                }if (_e50 === l) ;else if (c && null !== _t42 && null === _e50[4] && _e50[2] === _t42[5] && _e50[3] === _t42[6]) ;else if ((c || null === _t42 || null === _e50[4] || _e50[4] !== _t42[4] || _n46) && (c || null === _t42 || null !== _e50[4] || null !== _t42[4] || _e50[2] !== _t42[2] || _e50[3] !== _t42[3] || _n46)) if (!c && null === _t42 && null === _e50[4] && b && b[7] && null === b[4] && b[5] === _e50[2] && b[6] === _e50[3]) ;else if (c || null !== _t42 || null === _e50[4] || null === j || !(j < _e50[4])) break;j = null !== _e50 ? _e50[4] : null, v.push(s.nextOp), k.push(s.columns), x.push(new Array(s.nextOp[13])), D(r, s), _e50 = s.nextOp;
              }
            }v.length > 0 && (I = v[0]);var _d6 = b && b[0] === I[0] && b[1] === I[1],
                _u4 = b && null !== b[4] && b[4] === I[4],
                _E3 = b && null === b[4] && null === I[4] && (!b[7] && b[2] === I[2] && b[3] === I[3] || b[7] && b[5] === I[2] && b[6] === I[3]);if (0 === v.length && (!_d6 || !_u4 && !_E3)) break;var _O = !1,
                _A2 = 0;if (c || !_d6 || null === b[4] && null !== I[4] || null !== b[4] && null !== I[4] && I[4] < b[4]) {
              if (_A2 = v.length, !_d6 && !g && null === I[4] && !I[7]) throw new RangeError("could not find list element with ID: " + I[3] + "@" + r.actorIds[I[2]]);
            } else if (_u4 || _E3 || g) {
              for (var _e51 = 0; _e51 < v.length; _e51++) {
                var _t44 = v[_e51];for (var _n47 = 0; _n47 < _t44[13]; _n47++) {
                  if (_t44[14][_n47] === b[5] && _t44[15][_n47] === b[6]) {
                    var _s23 = 0;for (; _s23 < b[13] && (b[15][_s23] < _t44[6] || b[15][_s23] === _t44[6] && r.actorIds[b[14][_s23]] < p);) {
                      _s23++;
                    }b[15].splice(_s23, 0, _t44[6]), b[14].splice(_s23, 0, f), b[13]++, x[_e51][_n47] = !0;break;
                  }
                }
              }if (_E3 && (g = !0), g && !_E3) _A2 = v.length;else if (0 === v.length || b[6] < I[6] || b[6] === I[6] && r.actorIds[b[5]] < p) {
                _O = !0, F(e, t, h, b, r, y, o, _);for (var _e52 = v.length - 1; _e52 >= 0; _e52--) {
                  var _t45 = !0;for (var _n48 = 0; _n48 < v[_e52][13]; _n48++) {
                    x[_e52][_n48] || (_t45 = !1);
                  }"del" === i[v[_e52][8]] && _t45 && (v.splice(_e52, 1), k.splice(_e52, 1), x.splice(_e52, 1));
                }
              } else {
                if (b[6] === I[6] && r.actorIds[b[5]] === p) throw new RangeError("duplicate operation ID: " + I[6] + "@" + p);_A2 = 1;
              }
            } else _O = !0;if (_O && (B(n, r.blocks[a].columns, b), S(t, b, r.actorIds, !1), b[7] && m && (m = !1, o++), 0 === b[13] && (m = !0), t.numOps++, (_z2 = z(r, a), b = _z2.docOp, a = _z2.blockIndex, _z2), null !== b && (w++, _ = b[13])), _A2 > 0) {
              for (var _s24 = 0; _s24 < _A2; _s24++) {
                var _a8 = v[_s24];for (var _e53 = 0; _e53 < _a8[13]; _e53++) {
                  if (!x[_s24][_e53]) throw new RangeError("no matching operation for pred: " + _a8[15][_e53] + "@" + r.actorIds[_a8[14][_e53]]);
                }B(n, k[_s24], _a8), S(t, _a8, r.actorIds, !0), F(e, t, h, _a8, r, y, o), _a8[7] ? (m = !1, o++) : m = !0;
              }_A2 === v.length ? (v.length = 0, k.length = 0, x.length = 0) : (v.splice(0, _A2), k.splice(0, _A2), x.splice(0, _A2)), t.numOps += _A2;
            }
          }return b && (B(n, r.blocks[a].columns, b), t.numOps++, S(t, b, r.actorIds, !1)), { docOpsConsumed: w, blockIndex: a };
        }(e, I, k, t, n, y, g),
            x = _ref5.blockIndex,
            j = _ref5.docOpsConsumed,
            E = n.blocks[x];

        var O = -m - j;for (var _e54 = g; _e54 <= x; _e54++) {
          O += n.blocks[_e54].numOps;
        }U(k, E.columns, O), I.numOps += O;var _iteratorNormalCompletion46 = true;
        var _didIteratorError46 = false;
        var _iteratorError46 = undefined;

        try {
          for (var _iterator46 = E.columns[Symbol.iterator](), _step46; !(_iteratorNormalCompletion46 = (_step46 = _iterator46.next()).done); _iteratorNormalCompletion46 = true) {
            var _e55 = _step46.value;
            if (!_e55.decoder.done) throw new RangeError("excess ops in column " + _e55.columnId);
          }
        } catch (err) {
          _didIteratorError46 = true;
          _iteratorError46 = err;
        } finally {
          try {
            if (!_iteratorNormalCompletion46 && _iterator46.return) {
              _iterator46.return();
            }
          } finally {
            if (_didIteratorError46) {
              throw _iteratorError46;
            }
          }
        }

        if (I.columns = k.map(function (e) {
          var t = f(e.columnId, e.encoder.buffer);return { columnId: e.columnId, decoder: t };
        }), g === x && I.numOps <= v) O > 0 && void 0 !== w.lastVisibleActor && void 0 !== w.lastVisibleCtr && (I.lastVisibleActor = w.lastVisibleActor, I.lastVisibleCtr = w.lastVisibleCtr), n.blocks[g] = I;else {
          var _n$blocks;

          var _e56 = N(I);(_n$blocks = n.blocks).splice.apply(_n$blocks, [g, x - g + 1].concat(_toConsumableArray(_e56)));
        }
      }function Z(e, t) {
        if (t[0].columnId !== d[0].columnId || "objActor" !== d[0].columnName || t[1].columnId !== d[1].columnId || "objCtr" !== d[1].columnName || t[2].columnId !== d[2].columnId || "keyActor" !== d[2].columnName || t[3].columnId !== d[3].columnId || "keyCtr" !== d[3].columnName || t[4].columnId !== d[4].columnId || "keyStr" !== d[4].columnName || t[5].columnId !== d[5].columnId || "idActor" !== d[5].columnName || t[6].columnId !== d[6].columnId || "idCtr" !== d[6].columnName || t[7].columnId !== d[7].columnId || "insert" !== d[7].columnName || t[8].columnId !== d[8].columnId || "action" !== d[8].columnName || t[9].columnId !== d[9].columnId || "valLen" !== d[9].columnName || t[10].columnId !== d[10].columnId || "valRaw" !== d[10].columnName || t[13].columnId !== d[13].columnId || "predNum" !== d[13].columnName || t[14].columnId !== d[14].columnId || "predActor" !== d[14].columnName || t[15].columnId !== d[15].columnId || "predCtr" !== d[15].columnName) throw new RangeError("unexpected columnId");var n = e.blocks[0].columns;if (!t.every(function (e) {
          return x.includes(e.columnId) || n.find(function (t) {
            return t.columnId === e.columnId;
          });
        })) {
          var _s25 = n.map(function (e) {
            return { columnId: e.columnId };
          });
          var _loop = function _loop(_e57) {
            var t = _e57.columnId;
            x.includes(t) || n.find(function (e) {
              return e.columnId === t;
            }) || _s25.push({ columnId: t });
          };

          var _iteratorNormalCompletion47 = true;
          var _didIteratorError47 = false;
          var _iteratorError47 = undefined;

          try {
            for (var _iterator47 = t[Symbol.iterator](), _step47; !(_iteratorNormalCompletion47 = (_step47 = _iterator47.next()).done); _iteratorNormalCompletion47 = true) {
              var _e57 = _step47.value;

              _loop(_e57);
            }
          } catch (err) {
            _didIteratorError47 = true;
            _iteratorError47 = err;
          } finally {
            try {
              if (!_iteratorNormalCompletion47 && _iterator47.return) {
                _iterator47.return();
              }
            } finally {
              if (_didIteratorError47) {
                throw _iteratorError47;
              }
            }
          }

          _s25.sort(function (e, t) {
            return e.columnId - t.columnId;
          });for (var _t46 = 0; _t46 < e.blocks.length; _t46++) {
            var _n49 = r(e.blocks[_t46]);_n49.columns = p(_n49.columns.map(function (e) {
              return { columnId: e.columnId, buffer: e.decoder.buf };
            }), _s25), e.blocks[_t46] = _n49;
          }
        }
      }function G(e, t) {
        if (e.indexOf(t.actorIds[0]) < 0) {
          if (1 !== t.seq) throw new RangeError("Seq " + t.seq + " is the first change for actor " + t.actorIds[0]);e = e.concat([t.actorIds[0]]);
        }var n = [];var _iteratorNormalCompletion48 = true;
        var _didIteratorError48 = false;
        var _iteratorError48 = undefined;

        try {
          for (var _iterator48 = t.actorIds[Symbol.iterator](), _step48; !(_iteratorNormalCompletion48 = (_step48 = _iterator48.next()).done); _iteratorNormalCompletion48 = true) {
            var _s26 = _step48.value;
            var _t47 = e.indexOf(_s26);if (_t47 < 0) throw new RangeError("actorId " + _s26 + " is not known to document");n.push(_t47);
          }
        } catch (err) {
          _didIteratorError48 = true;
          _iteratorError48 = err;
        } finally {
          try {
            if (!_iteratorNormalCompletion48 && _iterator48.return) {
              _iterator48.return();
            }
          } finally {
            if (_didIteratorError48) {
              throw _iteratorError48;
            }
          }
        }

        return { actorIds: e, actorTable: n };
      }function K(e, t, n, s, o) {
        var a = new Set(n.heads),
            i = new Set(),
            l = r(n.clock),
            c = [],
            d = [];var _iteratorNormalCompletion49 = true;
        var _didIteratorError49 = false;
        var _iteratorError49 = undefined;

        try {
          for (var _iterator49 = t[Symbol.iterator](), _step49; !(_iteratorNormalCompletion49 = (_step49 = _iterator49.next()).done); _iteratorNormalCompletion49 = true) {
            var _e58 = _step49.value;
            if (void 0 !== n.changeIndexByHash[_e58.hash] || i.has(_e58.hash)) continue;var _s27 = (l[_e58.actor] || 0) + 1;var _r14 = !0;var _iteratorNormalCompletion50 = true;
            var _didIteratorError50 = false;
            var _iteratorError50 = undefined;

            try {
              for (var _iterator50 = _e58.deps[Symbol.iterator](), _step50; !(_iteratorNormalCompletion50 = (_step50 = _iterator50.next()).done); _iteratorNormalCompletion50 = true) {
                var _t49 = _step50.value;
                var _e59 = n.changeIndexByHash[_t49];void 0 !== _e59 && -1 !== _e59 || i.has(_t49) || (_r14 = !1);
              }
            } catch (err) {
              _didIteratorError50 = true;
              _iteratorError50 = err;
            } finally {
              try {
                if (!_iteratorNormalCompletion50 && _iterator50.return) {
                  _iterator50.return();
                }
              } finally {
                if (_didIteratorError50) {
                  throw _iteratorError50;
                }
              }
            }

            if (_r14) {
              if (_e58.seq < _s27) {
                if (o) throw new RangeError("Reuse of sequence number " + _e58.seq + " for actor " + _e58.actor);return [[], t];
              }if (_e58.seq > _s27) throw new RangeError("Skipped sequence number " + _s27 + " for actor " + _e58.actor);l[_e58.actor] = _e58.seq, i.add(_e58.hash);var _iteratorNormalCompletion51 = true;
              var _didIteratorError51 = false;
              var _iteratorError51 = undefined;

              try {
                for (var _iterator51 = _e58.deps[Symbol.iterator](), _step51; !(_iteratorNormalCompletion51 = (_step51 = _iterator51.next()).done); _iteratorNormalCompletion51 = true) {
                  var _t50 = _step51.value;
                  a.delete(_t50);
                }
              } catch (err) {
                _didIteratorError51 = true;
                _iteratorError51 = err;
              } finally {
                try {
                  if (!_iteratorNormalCompletion51 && _iterator51.return) {
                    _iterator51.return();
                  }
                } finally {
                  if (_didIteratorError51) {
                    throw _iteratorError51;
                  }
                }
              }

              a.add(_e58.hash), c.push(_e58);
            } else d.push(_e58);
          }
        } catch (err) {
          _didIteratorError49 = true;
          _iteratorError49 = err;
        } finally {
          try {
            if (!_iteratorNormalCompletion49 && _iterator49.return) {
              _iterator49.return();
            }
          } finally {
            if (_didIteratorError49) {
              throw _iteratorError49;
            }
          }
        }

        if (c.length > 0) {
          var _t48 = { changes: c, changeIndex: -1, objectIds: s };for (D(n, _t48); !_t48.done;) {
            q(e, _t48, n);
          }n.heads = [].concat(_toConsumableArray(a)).sort(), n.clock = l;
        }return [c, d];
      }function W(e) {
        var _iteratorNormalCompletion52 = true;
        var _didIteratorError52 = false;
        var _iteratorError52 = undefined;

        try {
          for (var _iterator52 = e.blocks[0].columns[Symbol.iterator](), _step52; !(_iteratorNormalCompletion52 = (_step52 = _iterator52.next()).done); _iteratorNormalCompletion52 = true) {
            var _t51 = _step52.value;
            _t51.decoder.reset();
          }
        } catch (err) {
          _didIteratorError52 = true;
          _iteratorError52 = err;
        } finally {
          try {
            if (!_iteratorNormalCompletion52 && _iterator52.return) {
              _iterator52.return();
            }
          } finally {
            if (_didIteratorError52) {
              throw _iteratorError52;
            }
          }
        }

        var t = {},
            n = null,
            s = 0,
            r = { _root: { objectId: "_root", type: "map", props: {} } },
            o = null,
            a = null,
            i = "_root",
            l = !1,
            c = 0;for (; (_z3 = z(e, s), n = _z3.docOp, s = _z3.blockIndex, _z3), null !== n;) {
          var _z3;

          n[0] === o && n[1] === a || (i = n[1] + "@" + e.actorIds[n[0]], o = n[0], a = n[1], t = {}, c = 0, l = !1), n[7] && l && (l = !1, c++), 0 === n[13] && (l = !0), n[6] > e.maxOp && (e.maxOp = n[6]);for (var _t52 = 0; _t52 < n[13]; _t52++) {
            n[15][_t52] > e.maxOp && (e.maxOp = n[15][_t52]);
          }F(r, null, i, n, e, t, c, n[13]);
        }return r._root;
      }function Y(e, t, n, s) {
        B(e, u, [n.indexOf(t.actor), t.seq, t.maxOp, t.time, t.message, t.deps.length, t.deps.map(function (e) {
          return s[e];
        }), t.extraBytes ? t.extraBytes.byteLength << 4 | a.BYTES : a.BYTES, t.extraBytes]);
      }
      var J = function () {
        function J(e) {
          _classCallCheck(this, J);

          if (this.maxOp = 0, this.haveHashGraph = !1, this.changes = [], this.changeIndexByHash = {}, this.dependenciesByHash = {}, this.dependentsByHash = {}, this.hashesByActor = {}, this.actorIds = [], this.heads = [], this.clock = {}, this.queue = [], this.objectMeta = { _root: { parentObj: null, parentKey: null, opId: null, type: "map", children: {} } }, e) {
            var _t53 = _(e),
                _ref6 = function (e) {
              var t = p(e.changesColumns, u),
                  n = t[0].decoder,
                  s = t[1].decoder,
                  r = t[5].decoder,
                  o = t[6].decoder;if (t[0].columnId !== u[0].columnId || "actor" !== u[0].columnName || t[1].columnId !== u[1].columnId || "seq" !== u[1].columnName || t[5].columnId !== u[5].columnId || "depsNum" !== u[5].columnName || t[6].columnId !== u[6].columnId || "depsIndex" !== u[6].columnName) throw new RangeError("unexpected columnId");var a = 0,
                  i = {},
                  l = [],
                  c = new Set();for (; !n.done;) {
                var _t54 = n.readValue(),
                    _d7 = s.readValue(),
                    _u5 = r.readValue(),
                    _h4 = e.actorIds[_t54];if (1 !== _d7 && _d7 !== i[_h4] + 1) throw new RangeError("Expected seq " + (i[_h4] + 1) + ", got " + _d7 + " for actor " + _h4);l.push(_t54), i[_h4] = _d7, c.add(a);for (var _e60 = 0; _e60 < _u5; _e60++) {
                  c.delete(o.readValue());
                }a++;
              }var d = [].concat(_toConsumableArray(c)).map(function (t) {
                return e.actorIds[l[t]];
              }).sort();var _iteratorNormalCompletion53 = true;
              var _didIteratorError53 = false;
              var _iteratorError53 = undefined;

              try {
                for (var _iterator53 = t[Symbol.iterator](), _step53; !(_iteratorNormalCompletion53 = (_step53 = _iterator53.next()).done); _iteratorNormalCompletion53 = true) {
                  var _e61 = _step53.value;
                  _e61.decoder.reset();
                }
              } catch (err) {
                _didIteratorError53 = true;
                _iteratorError53 = err;
              } finally {
                try {
                  if (!_iteratorNormalCompletion53 && _iterator53.return) {
                    _iterator53.return();
                  }
                } finally {
                  if (_didIteratorError53) {
                    throw _iteratorError53;
                  }
                }
              }

              var f = t.map(function (e) {
                return { columnId: e.columnId, encoder: h(e.columnId) };
              });return U(f, t, a), { clock: i, headActors: d, encoders: f, numChanges: a };
            }(_t53),
                _n50 = _ref6.clock,
                _s28 = _ref6.headActors,
                _r15 = _ref6.encoders,
                _o14 = _ref6.numChanges;if (this.binaryDoc = e, this.changes = new Array(_o14), this.actorIds = _t53.actorIds, this.heads = _t53.heads, this.clock = _n50, this.changesEncoders = _r15, this.extraBytes = _t53.extraBytes, 1 === _t53.heads.length && 1 === _s28.length && (this.hashesByActor[_s28[0]] = [], this.hashesByActor[_s28[0]][_n50[_s28[0]] - 1] = _t53.heads[0]), _t53.heads.length === _t53.headsIndexes.length) for (var _e62 = 0; _e62 < _t53.heads.length; _e62++) {
              this.changeIndexByHash[_t53.heads[_e62]] = _t53.headsIndexes[_e62];
            } else if (1 === _t53.heads.length) this.changeIndexByHash[_t53.heads[0]] = _o14 - 1;else {
              var _iteratorNormalCompletion54 = true;
              var _didIteratorError54 = false;
              var _iteratorError54 = undefined;

              try {
                for (var _iterator54 = _t53.heads[Symbol.iterator](), _step54; !(_iteratorNormalCompletion54 = (_step54 = _iterator54.next()).done); _iteratorNormalCompletion54 = true) {
                  var _e63 = _step54.value;
                  this.changeIndexByHash[_e63] = -1;
                }
              } catch (err) {
                _didIteratorError54 = true;
                _iteratorError54 = err;
              } finally {
                try {
                  if (!_iteratorNormalCompletion54 && _iterator54.return) {
                    _iterator54.return();
                  }
                } finally {
                  if (_didIteratorError54) {
                    throw _iteratorError54;
                  }
                }
              }
            }this.blocks = [{ columns: p(_t53.opsColumns, c) }], V(this.blocks[0]), this.blocks[0].numOps > v && (this.blocks = N(this.blocks[0]));var _a9 = { blocks: this.blocks, actorIds: this.actorIds, objectMeta: this.objectMeta, maxOp: 0 };this.initPatch = W(_a9), this.maxOp = _a9.maxOp;
          } else this.haveHashGraph = !0, this.changesEncoders = u.map(function (e) {
            return { columnId: e.columnId, encoder: h(e.columnId) };
          }), this.blocks = [{ columns: p([], c), bloom: new Uint8Array(k), numOps: 0, lastKey: void 0, numVisible: void 0, lastObjectActor: void 0, lastObjectCtr: void 0, firstVisibleActor: void 0, firstVisibleCtr: void 0, lastVisibleActor: void 0, lastVisibleCtr: void 0 }];
        }

        _createClass(J, [{
          key: "clone",
          value: function clone() {
            var e = new J();return e.maxOp = this.maxOp, e.haveHashGraph = this.haveHashGraph, e.changes = this.changes.slice(), e.changeIndexByHash = r(this.changeIndexByHash), e.dependenciesByHash = r(this.dependenciesByHash), e.dependentsByHash = Object.entries(this.dependentsByHash).reduce(function (e, _ref7) {
              var _ref8 = _slicedToArray(_ref7, 2),
                  t = _ref8[0],
                  n = _ref8[1];

              return e[t] = n.slice(), e;
            }, {}), e.hashesByActor = Object.entries(this.hashesByActor).reduce(function (e, _ref9) {
              var _ref10 = _slicedToArray(_ref9, 2),
                  t = _ref10[0],
                  n = _ref10[1];

              return e[t] = n.slice(), e;
            }, {}), e.actorIds = this.actorIds, e.heads = this.heads, e.clock = this.clock, e.blocks = this.blocks, e.objectMeta = this.objectMeta, e.queue = this.queue, e;
          }
        }, {
          key: "applyChanges",
          value: function applyChanges(e) {
            var t = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : !1;
            var n = e.map(function (e) {
              var t = m(e);return t.buffer = e, t;
            }),
                r = { _root: { objectId: "_root", type: "map", props: {} } },
                o = { maxOp: this.maxOp, changeIndexByHash: this.changeIndexByHash, actorIds: this.actorIds, heads: this.heads, clock: this.clock, blocks: this.blocks.slice(), objectMeta: Object.assign({}, this.objectMeta) },
                a = 0 === this.queue.length ? n : n.concat(this.queue),
                i = [],
                l = new Set();for (;;) {
              var _K = K(r, a, o, l, this.haveHashGraph),
                  _K2 = _slicedToArray(_K, 2),
                  _e64 = _K2[0],
                  _t55 = _K2[1];

              a = _t55;for (var _t56 = 0; _t56 < _e64.length; _t56++) {
                o.changeIndexByHash[_e64[_t56].hash] = this.changes.length + i.length + _t56;
              }if (_e64.length > 0 && (i = i.concat(_e64)), 0 === a.length) break;if (0 === _e64.length) {
                if (this.haveHashGraph) break;this.computeHashGraph(), o.changeIndexByHash = this.changeIndexByHash;
              }
            }!function (e, t, n) {
              var _iteratorNormalCompletion55 = true;
              var _didIteratorError55 = false;
              var _iteratorError55 = undefined;

              try {
                for (var _iterator55 = t[Symbol.iterator](), _step55; !(_iteratorNormalCompletion55 = (_step55 = _iterator55.next()).done); _iteratorNormalCompletion55 = true) {
                  var _r16 = _step55.value;
                  var _t57 = n.objectMeta[_r16],
                      _o15 = null,
                      _a10 = !1;for (;;) {
                    var _i8 = _o15 && Object.keys(_t57.children[_o15.parentKey]).length > 0;if (e[_r16] || (e[_r16] = H(_r16, _t57.type)), _o15 && _i8) if ("list" === _t57.type || "text" === _t57.type) {
                      var _iteratorNormalCompletion56 = true;
                      var _didIteratorError56 = false;
                      var _iteratorError56 = undefined;

                      try {
                        for (var _iterator56 = e[_r16].edits[Symbol.iterator](), _step56; !(_iteratorNormalCompletion56 = (_step56 = _iterator56.next()).done); _iteratorNormalCompletion56 = true) {
                          var _n51 = _step56.value;
                          _n51.opId && _t57.children[_o15.parentKey][_n51.opId] && (_a10 = !0);
                        }
                      } catch (err) {
                        _didIteratorError56 = true;
                        _iteratorError56 = err;
                      } finally {
                        try {
                          if (!_iteratorNormalCompletion56 && _iterator56.return) {
                            _iterator56.return();
                          }
                        } finally {
                          if (_didIteratorError56) {
                            throw _iteratorError56;
                          }
                        }
                      }

                      if (!_a10) {
                        var _a11 = s(_r16),
                            _i9 = s(_o15.parentKey),
                            _l2 = { objActor: _a11.actorId, objCtr: _a11.counter, keyActor: _i9.actorId, keyCtr: _i9.counter, objActorNum: n.actorIds.indexOf(_a11.actorId), keyActorNum: n.actorIds.indexOf(_i9.actorId), keyStr: null, insert: !1, objId: _r16 },
                            _A3 = A(n, _l2),
                            _c5 = _A3.visibleCount;var _iteratorNormalCompletion57 = true;
                        var _didIteratorError57 = false;
                        var _iteratorError57 = undefined;

                        try {
                          for (var _iterator57 = Object.entries(_t57.children[_o15.parentKey])[Symbol.iterator](), _step57; !(_iteratorNormalCompletion57 = (_step57 = _iterator57.next()).done); _iteratorNormalCompletion57 = true) {
                            var _ref11 = _step57.value;

                            var _ref12 = _slicedToArray(_ref11, 2);

                            var _n52 = _ref12[0];
                            var _s29 = _ref12[1];
                            var _t58 = _s29;_s29.objectId && (e[_s29.objectId] || (e[_s29.objectId] = H(_s29.objectId, _s29.type)), _t58 = e[_s29.objectId]);var _o16 = { action: "update", index: _c5, opId: _n52, value: _t58 };M(e[_r16].edits, _o16);
                          }
                        } catch (err) {
                          _didIteratorError57 = true;
                          _iteratorError57 = err;
                        } finally {
                          try {
                            if (!_iteratorNormalCompletion57 && _iterator57.return) {
                              _iterator57.return();
                            }
                          } finally {
                            if (_didIteratorError57) {
                              throw _iteratorError57;
                            }
                          }
                        }
                      }
                    } else {
                      e[_r16].props[_o15.parentKey] || (e[_r16].props[_o15.parentKey] = {});var _n53 = e[_r16].props[_o15.parentKey];var _iteratorNormalCompletion58 = true;
                      var _didIteratorError58 = false;
                      var _iteratorError58 = undefined;

                      try {
                        for (var _iterator58 = Object.entries(_t57.children[_o15.parentKey])[Symbol.iterator](), _step58; !(_iteratorNormalCompletion58 = (_step58 = _iterator58.next()).done); _iteratorNormalCompletion58 = true) {
                          var _ref13 = _step58.value;

                          var _ref14 = _slicedToArray(_ref13, 2);

                          var _s30 = _ref14[0];
                          var _r17 = _ref14[1];
                          _n53[_s30] ? _a10 = !0 : _r17.objectId ? (e[_r17.objectId] || (e[_r17.objectId] = H(_r17.objectId, _r17.type)), _n53[_s30] = e[_r17.objectId]) : _n53[_s30] = _r17;
                        }
                      } catch (err) {
                        _didIteratorError58 = true;
                        _iteratorError58 = err;
                      } finally {
                        try {
                          if (!_iteratorNormalCompletion58 && _iterator58.return) {
                            _iterator58.return();
                          }
                        } finally {
                          if (_didIteratorError58) {
                            throw _iteratorError58;
                          }
                        }
                      }
                    }if (_a10 || !_t57.parentObj || _o15 && !_i8) break;_o15 = _t57, _r16 = _t57.parentObj, _t57 = n.objectMeta[_r16];
                  }
                }
              } catch (err) {
                _didIteratorError55 = true;
                _iteratorError55 = err;
              } finally {
                try {
                  if (!_iteratorNormalCompletion55 && _iterator55.return) {
                    _iterator55.return();
                  }
                } finally {
                  if (_didIteratorError55) {
                    throw _iteratorError55;
                  }
                }
              }
            }(r, l, o);var _iteratorNormalCompletion59 = true;
            var _didIteratorError59 = false;
            var _iteratorError59 = undefined;

            try {
              for (var _iterator59 = i[Symbol.iterator](), _step59; !(_iteratorNormalCompletion59 = (_step59 = _iterator59.next()).done); _iteratorNormalCompletion59 = true) {
                var _e65 = _step59.value;
                this.changes.push(_e65.buffer), this.hashesByActor[_e65.actor] || (this.hashesByActor[_e65.actor] = []), this.hashesByActor[_e65.actor][_e65.seq - 1] = _e65.hash, this.changeIndexByHash[_e65.hash] = this.changes.length - 1, this.dependenciesByHash[_e65.hash] = _e65.deps, this.dependentsByHash[_e65.hash] = [];var _iteratorNormalCompletion60 = true;
                var _didIteratorError60 = false;
                var _iteratorError60 = undefined;

                try {
                  for (var _iterator60 = _e65.deps[Symbol.iterator](), _step60; !(_iteratorNormalCompletion60 = (_step60 = _iterator60.next()).done); _iteratorNormalCompletion60 = true) {
                    var _t59 = _step60.value;
                    this.dependentsByHash[_t59] || (this.dependentsByHash[_t59] = []), this.dependentsByHash[_t59].push(_e65.hash);
                  }
                } catch (err) {
                  _didIteratorError60 = true;
                  _iteratorError60 = err;
                } finally {
                  try {
                    if (!_iteratorNormalCompletion60 && _iterator60.return) {
                      _iterator60.return();
                    }
                  } finally {
                    if (_didIteratorError60) {
                      throw _iteratorError60;
                    }
                  }
                }

                Y(this.changesEncoders, _e65, o.actorIds, this.changeIndexByHash);
              }
            } catch (err) {
              _didIteratorError59 = true;
              _iteratorError59 = err;
            } finally {
              try {
                if (!_iteratorNormalCompletion59 && _iterator59.return) {
                  _iterator59.return();
                }
              } finally {
                if (_didIteratorError59) {
                  throw _iteratorError59;
                }
              }
            }

            this.maxOp = o.maxOp, this.actorIds = o.actorIds, this.heads = o.heads, this.clock = o.clock, this.blocks = o.blocks, this.objectMeta = o.objectMeta, this.queue = a, this.binaryDoc = null, this.initPatch = null;var c = { maxOp: this.maxOp, clock: this.clock, deps: this.heads, pendingChanges: this.queue.length, diffs: r._root };return t && 1 === n.length && (c.actor = n[0].actor, c.seq = n[0].seq), c;
          }
        }, {
          key: "computeHashGraph",
          value: function computeHashGraph() {
            var e = this.save();this.haveHashGraph = !0, this.changes = [], this.changeIndexByHash = {}, this.dependenciesByHash = {}, this.dependentsByHash = {}, this.hashesByActor = {}, this.clock = {};var _iteratorNormalCompletion61 = true;
            var _didIteratorError61 = false;
            var _iteratorError61 = undefined;

            try {
              for (var _iterator61 = w([e])[Symbol.iterator](), _step61; !(_iteratorNormalCompletion61 = (_step61 = _iterator61.next()).done); _iteratorNormalCompletion61 = true) {
                var _t60 = _step61.value;
                var _e66 = g(_t60);this.changes.push(_e66), this.changeIndexByHash[_t60.hash] = this.changes.length - 1, this.dependenciesByHash[_t60.hash] = _t60.deps, this.dependentsByHash[_t60.hash] = [];var _iteratorNormalCompletion62 = true;
                var _didIteratorError62 = false;
                var _iteratorError62 = undefined;

                try {
                  for (var _iterator62 = _t60.deps[Symbol.iterator](), _step62; !(_iteratorNormalCompletion62 = (_step62 = _iterator62.next()).done); _iteratorNormalCompletion62 = true) {
                    var _e67 = _step62.value;
                    this.dependentsByHash[_e67].push(_t60.hash);
                  }
                } catch (err) {
                  _didIteratorError62 = true;
                  _iteratorError62 = err;
                } finally {
                  try {
                    if (!_iteratorNormalCompletion62 && _iterator62.return) {
                      _iterator62.return();
                    }
                  } finally {
                    if (_didIteratorError62) {
                      throw _iteratorError62;
                    }
                  }
                }

                1 === _t60.seq && (this.hashesByActor[_t60.actor] = []), this.hashesByActor[_t60.actor].push(_t60.hash);var _n54 = (this.clock[_t60.actor] || 0) + 1;if (_t60.seq !== _n54) throw new RangeError("Expected seq " + _n54 + ", got seq " + _t60.seq + " from actor " + _t60.actor);this.clock[_t60.actor] = _t60.seq;
              }
            } catch (err) {
              _didIteratorError61 = true;
              _iteratorError61 = err;
            } finally {
              try {
                if (!_iteratorNormalCompletion61 && _iterator61.return) {
                  _iterator61.return();
                }
              } finally {
                if (_didIteratorError61) {
                  throw _iteratorError61;
                }
              }
            }
          }
        }, {
          key: "getChanges",
          value: function getChanges(e) {
            var _this7 = this;

            if (this.haveHashGraph || this.computeHashGraph(), 0 === e.length) return this.changes.slice();var t = [],
                n = {},
                s = [];var _iteratorNormalCompletion63 = true;
            var _didIteratorError63 = false;
            var _iteratorError63 = undefined;

            try {
              for (var _iterator63 = e[Symbol.iterator](), _step63; !(_iteratorNormalCompletion63 = (_step63 = _iterator63.next()).done); _iteratorNormalCompletion63 = true) {
                var _t63;

                var _s31 = _step63.value;
                n[_s31] = !0;var _e68 = this.dependentsByHash[_s31];if (!_e68) throw new RangeError("hash not found: " + _s31);(_t63 = t).push.apply(_t63, _toConsumableArray(_e68));
              }
            } catch (err) {
              _didIteratorError63 = true;
              _iteratorError63 = err;
            } finally {
              try {
                if (!_iteratorNormalCompletion63 && _iterator63.return) {
                  _iterator63.return();
                }
              } finally {
                if (_didIteratorError63) {
                  throw _iteratorError63;
                }
              }
            }

            for (; t.length > 0;) {
              var _t61;

              var _e69 = t.pop();if (n[_e69] = !0, s.push(_e69), !this.dependenciesByHash[_e69].every(function (e) {
                return n[e];
              })) break;(_t61 = t).push.apply(_t61, _toConsumableArray(this.dependentsByHash[_e69]));
            }if (0 === t.length && this.heads.every(function (e) {
              return n[e];
            })) return s.map(function (e) {
              return _this7.changes[_this7.changeIndexByHash[e]];
            });for (t = e.slice(), n = {}; t.length > 0;) {
              var _e70 = t.pop();if (!n[_e70]) {
                var _t62;

                var _s32 = this.dependenciesByHash[_e70];if (!_s32) throw new RangeError("hash not found: " + _e70);(_t62 = t).push.apply(_t62, _toConsumableArray(_s32)), n[_e70] = !0;
              }
            }return this.changes.filter(function (e) {
              return !n[y(e, !0).hash];
            });
          }
        }, {
          key: "getChangesAdded",
          value: function getChangesAdded(e) {
            var _this8 = this;

            this.haveHashGraph || this.computeHashGraph();var t = this.heads.slice(),
                n = {},
                s = [];for (; t.length > 0;) {
              var _r18 = t.pop();n[_r18] || void 0 !== e.changeIndexByHash[_r18] || (n[_r18] = !0, s.push(_r18), t.push.apply(t, _toConsumableArray(this.dependenciesByHash[_r18])));
            }return s.reverse().map(function (e) {
              return _this8.changes[_this8.changeIndexByHash[e]];
            });
          }
        }, {
          key: "getChangeByHash",
          value: function getChangeByHash(e) {
            return this.haveHashGraph || this.computeHashGraph(), this.changes[this.changeIndexByHash[e]];
          }
        }, {
          key: "getMissingDeps",
          value: function getMissingDeps() {
            var e = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : [];
            this.haveHashGraph || this.computeHashGraph();var t = new Set(e),
                n = new Set();var _iteratorNormalCompletion64 = true;
            var _didIteratorError64 = false;
            var _iteratorError64 = undefined;

            try {
              for (var _iterator64 = this.queue[Symbol.iterator](), _step64; !(_iteratorNormalCompletion64 = (_step64 = _iterator64.next()).done); _iteratorNormalCompletion64 = true) {
                var _e71 = _step64.value;
                n.add(_e71.hash);var _iteratorNormalCompletion66 = true;
                var _didIteratorError66 = false;
                var _iteratorError66 = undefined;

                try {
                  for (var _iterator66 = _e71.deps[Symbol.iterator](), _step66; !(_iteratorNormalCompletion66 = (_step66 = _iterator66.next()).done); _iteratorNormalCompletion66 = true) {
                    var _n55 = _step66.value;
                    t.add(_n55);
                  }
                } catch (err) {
                  _didIteratorError66 = true;
                  _iteratorError66 = err;
                } finally {
                  try {
                    if (!_iteratorNormalCompletion66 && _iterator66.return) {
                      _iterator66.return();
                    }
                  } finally {
                    if (_didIteratorError66) {
                      throw _iteratorError66;
                    }
                  }
                }
              }
            } catch (err) {
              _didIteratorError64 = true;
              _iteratorError64 = err;
            } finally {
              try {
                if (!_iteratorNormalCompletion64 && _iterator64.return) {
                  _iterator64.return();
                }
              } finally {
                if (_didIteratorError64) {
                  throw _iteratorError64;
                }
              }
            }

            var s = [];var _iteratorNormalCompletion65 = true;
            var _didIteratorError65 = false;
            var _iteratorError65 = undefined;

            try {
              for (var _iterator65 = t[Symbol.iterator](), _step65; !(_iteratorNormalCompletion65 = (_step65 = _iterator65.next()).done); _iteratorNormalCompletion65 = true) {
                var _e72 = _step65.value;
                void 0 !== this.changeIndexByHash[_e72] || n.has(_e72) || s.push(_e72);
              }
            } catch (err) {
              _didIteratorError65 = true;
              _iteratorError65 = err;
            } finally {
              try {
                if (!_iteratorNormalCompletion65 && _iterator65.return) {
                  _iterator65.return();
                }
              } finally {
                if (_didIteratorError65) {
                  throw _iteratorError65;
                }
              }
            }

            return s.sort();
          }
        }, {
          key: "save",
          value: function save() {
            var _this9 = this;

            if (this.binaryDoc) return this.binaryDoc;var e = this.changesEncoders.map(function (e) {
              return { columnId: e.columnId, encoder: h(e.columnId) };
            });return U(e, this.changesEncoders.map(function (e) {
              var t = f(e.columnId, e.encoder.buffer);return { columnId: e.columnId, decoder: t };
            }), this.changes.length), this.binaryDoc = I({ changesColumns: this.changesEncoders, opsColumns: T(this.blocks), actorIds: this.actorIds, heads: this.heads, headsIndexes: this.heads.map(function (e) {
                return _this9.changeIndexByHash[e];
              }), extraBytes: this.extraBytes }), this.changesEncoders = e, this.binaryDoc;
          }
        }, {
          key: "getPatch",
          value: function getPatch() {
            var e = { blocks: this.blocks, actorIds: this.actorIds, objectMeta: { _root: { parentObj: null, parentKey: null, opId: null, type: "map", children: {} } }, maxOp: 0 },
                t = this.initPatch ? this.initPatch : W(e);return { maxOp: this.maxOp, clock: this.clock, deps: this.heads, pendingChanges: this.queue.length, diffs: t };
          }
        }]);

        return J;
      }();

      e.exports = { MAX_BLOCK_SIZE: v, BackendDoc: J, bloomFilterContains: C };
    }, "./backend/sync.js":
    /*!*************************!*\
      !*** ./backend/sync.js ***!
      \*************************/function backendSyncJs(e, t, n) {
      var s = n( /*! ./backend */"./backend/backend.js"),
          _n56 = n( /*! ./encoding */"./backend/encoding.js"),
          r = _n56.hexStringToBytes,
          o = _n56.bytesToHexString,
          a = _n56.Encoder,
          i = _n56.Decoder,
          _n57 = n( /*! ./columnar */"./backend/columnar.js"),
          l = _n57.decodeChangeMeta,
          _n58 = n( /*! ../src/common */"./src/common.js"),
          c = _n58.copyObject;
      var d = function () {
        function d(e) {
          _classCallCheck(this, d);

          if (Array.isArray(e)) {
            this.numEntries = e.length, this.numBitsPerEntry = 10, this.numProbes = 7, this.bits = new Uint8Array(Math.ceil(this.numEntries * this.numBitsPerEntry / 8));var _iteratorNormalCompletion67 = true;
            var _didIteratorError67 = false;
            var _iteratorError67 = undefined;

            try {
              for (var _iterator67 = e[Symbol.iterator](), _step67; !(_iteratorNormalCompletion67 = (_step67 = _iterator67.next()).done); _iteratorNormalCompletion67 = true) {
                var _t64 = _step67.value;
                this.addHash(_t64);
              }
            } catch (err) {
              _didIteratorError67 = true;
              _iteratorError67 = err;
            } finally {
              try {
                if (!_iteratorNormalCompletion67 && _iterator67.return) {
                  _iterator67.return();
                }
              } finally {
                if (_didIteratorError67) {
                  throw _iteratorError67;
                }
              }
            }
          } else {
            if (!(e instanceof Uint8Array)) throw new TypeError("invalid argument");if (0 === e.byteLength) this.numEntries = 0, this.numBitsPerEntry = 0, this.numProbes = 0, this.bits = e;else {
              var _t65 = new i(e);this.numEntries = _t65.readUint32(), this.numBitsPerEntry = _t65.readUint32(), this.numProbes = _t65.readUint32(), this.bits = _t65.readRawBytes(Math.ceil(this.numEntries * this.numBitsPerEntry / 8));
            }
          }
        }

        _createClass(d, [{
          key: "getProbes",
          value: function getProbes(e) {
            var t = r(e),
                n = 8 * this.bits.byteLength;if (32 !== t.byteLength) throw new RangeError("Not a 256-bit hash: " + e);var s = ((t[0] | t[1] << 8 | t[2] << 16 | t[3] << 24) >>> 0) % n,
                o = ((t[4] | t[5] << 8 | t[6] << 16 | t[7] << 24) >>> 0) % n,
                a = ((t[8] | t[9] << 8 | t[10] << 16 | t[11] << 24) >>> 0) % n;var i = [s];for (var _e73 = 1; _e73 < this.numProbes; _e73++) {
              s = (s + o) % n, o = (o + a) % n, i.push(s);
            }return i;
          }
        }, {
          key: "addHash",
          value: function addHash(e) {
            var _iteratorNormalCompletion68 = true;
            var _didIteratorError68 = false;
            var _iteratorError68 = undefined;

            try {
              for (var _iterator68 = this.getProbes(e)[Symbol.iterator](), _step68; !(_iteratorNormalCompletion68 = (_step68 = _iterator68.next()).done); _iteratorNormalCompletion68 = true) {
                var _t66 = _step68.value;
                this.bits[_t66 >>> 3] |= 1 << (7 & _t66);
              }
            } catch (err) {
              _didIteratorError68 = true;
              _iteratorError68 = err;
            } finally {
              try {
                if (!_iteratorNormalCompletion68 && _iterator68.return) {
                  _iterator68.return();
                }
              } finally {
                if (_didIteratorError68) {
                  throw _iteratorError68;
                }
              }
            }
          }
        }, {
          key: "containsHash",
          value: function containsHash(e) {
            if (0 === this.numEntries) return !1;var _iteratorNormalCompletion69 = true;
            var _didIteratorError69 = false;
            var _iteratorError69 = undefined;

            try {
              for (var _iterator69 = this.getProbes(e)[Symbol.iterator](), _step69; !(_iteratorNormalCompletion69 = (_step69 = _iterator69.next()).done); _iteratorNormalCompletion69 = true) {
                var _t67 = _step69.value;
                if (0 == (this.bits[_t67 >>> 3] & 1 << (7 & _t67))) return !1;
              }
            } catch (err) {
              _didIteratorError69 = true;
              _iteratorError69 = err;
            } finally {
              try {
                if (!_iteratorNormalCompletion69 && _iterator69.return) {
                  _iterator69.return();
                }
              } finally {
                if (_didIteratorError69) {
                  throw _iteratorError69;
                }
              }
            }

            return !0;
          }
        }, {
          key: "bytes",
          get: function get() {
            if (0 === this.numEntries) return new Uint8Array(0);var e = new a();return e.appendUint32(this.numEntries), e.appendUint32(this.numBitsPerEntry), e.appendUint32(this.numProbes), e.appendRawBytes(this.bits), e.buffer;
          }
        }]);

        return d;
      }();

      function u(e, t) {
        if (!Array.isArray(t)) throw new TypeError("hashes must be an array");e.appendUint32(t.length);for (var _n59 = 0; _n59 < t.length; _n59++) {
          if (_n59 > 0 && t[_n59 - 1] >= t[_n59]) throw new RangeError("hashes must be sorted");var _s33 = r(t[_n59]);if (32 !== _s33.byteLength) throw new TypeError("heads hashes must be 256 bits");e.appendRawBytes(_s33);
        }
      }function h(e) {
        var t = e.readUint32(),
            n = [];for (var _s34 = 0; _s34 < t; _s34++) {
          n.push(o(e.readRawBytes(32)));
        }return n;
      }function f(e) {
        var t = new a();t.appendByte(66), u(t, e.heads), u(t, e.need), t.appendUint32(e.have.length);var _iteratorNormalCompletion70 = true;
        var _didIteratorError70 = false;
        var _iteratorError70 = undefined;

        try {
          for (var _iterator70 = e.have[Symbol.iterator](), _step70; !(_iteratorNormalCompletion70 = (_step70 = _iterator70.next()).done); _iteratorNormalCompletion70 = true) {
            var _n60 = _step70.value;
            u(t, _n60.lastSync), t.appendPrefixedBytes(_n60.bloom);
          }
        } catch (err) {
          _didIteratorError70 = true;
          _iteratorError70 = err;
        } finally {
          try {
            if (!_iteratorNormalCompletion70 && _iterator70.return) {
              _iterator70.return();
            }
          } finally {
            if (_didIteratorError70) {
              throw _iteratorError70;
            }
          }
        }

        t.appendUint32(e.changes.length);var _iteratorNormalCompletion71 = true;
        var _didIteratorError71 = false;
        var _iteratorError71 = undefined;

        try {
          for (var _iterator71 = e.changes[Symbol.iterator](), _step71; !(_iteratorNormalCompletion71 = (_step71 = _iterator71.next()).done); _iteratorNormalCompletion71 = true) {
            var _n61 = _step71.value;
            t.appendPrefixedBytes(_n61);
          }
        } catch (err) {
          _didIteratorError71 = true;
          _iteratorError71 = err;
        } finally {
          try {
            if (!_iteratorNormalCompletion71 && _iterator71.return) {
              _iterator71.return();
            }
          } finally {
            if (_didIteratorError71) {
              throw _iteratorError71;
            }
          }
        }

        return t.buffer;
      }function p(e) {
        var t = new i(e),
            n = t.readByte();if (66 !== n) throw new RangeError("Unexpected message type: " + n);var s = h(t),
            r = h(t),
            o = t.readUint32();var a = { heads: s, need: r, have: [], changes: [] };for (var _e74 = 0; _e74 < o; _e74++) {
          var _e75 = h(t),
              _n62 = t.readPrefixedBytes(t);a.have.push({ lastSync: _e75, bloom: _n62 });
        }var l = t.readUint32();for (var _e76 = 0; _e76 < l; _e76++) {
          var _e77 = t.readPrefixedBytes();a.changes.push(_e77);
        }return a;
      }function b(e, t) {
        var n = s.getChanges(e, t).map(function (e) {
          return l(e, !0).hash;
        });return { lastSync: t, bloom: new d(n).bytes };
      }function g() {
        return { sharedHeads: [], lastSentHeads: [], theirHeads: null, theirNeed: null, theirHave: null, sentHashes: {} };
      }function m(e, t) {
        return e.length === t.length && e.every(function (e, n) {
          return e === t[n];
        });
      }e.exports = { receiveSyncMessage: function receiveSyncMessage(e, t, n) {
          var _s$applyChanges, _s$applyChanges2;

          if (!e) throw new Error("generateSyncMessage called with no Automerge document");if (!t) throw new Error("generateSyncMessage requires a syncState, which can be created with initSyncState()");var r = t.sharedHeads,
              o = t.lastSentHeads,
              a = t.sentHashes,
              i = null;
          var l = p(n),
              c = s.getHeads(e);l.changes.length > 0 && ((_s$applyChanges = s.applyChanges(e, l.changes), _s$applyChanges2 = _slicedToArray(_s$applyChanges, 2), e = _s$applyChanges2[0], i = _s$applyChanges2[1], _s$applyChanges), r = function (e, t, n) {
            var s = t.filter(function (t) {
              return !e.includes(t);
            }),
                r = n.filter(function (e) {
              return t.includes(e);
            });return [].concat(_toConsumableArray(new Set([].concat(_toConsumableArray(s), _toConsumableArray(r))))).sort();
          }(c, s.getHeads(e), r)), 0 === l.changes.length && m(l.heads, c) && (o = l.heads);var d = l.heads.filter(function (t) {
            return s.getChangeByHash(e, t);
          });d.length === l.heads.length ? (r = l.heads, 0 === l.heads.length && (o = [], a = [])) : r = [].concat(_toConsumableArray(new Set(d.concat(r)))).sort();var u = { sharedHeads: r, lastSentHeads: o, theirHave: l.have, theirHeads: l.heads, theirNeed: l.need, sentHashes: a };return [e, u, i];
        }, generateSyncMessage: function generateSyncMessage(e, t) {
          if (!e) throw new Error("generateSyncMessage called with no Automerge document");if (!t) throw new Error("generateSyncMessage requires a syncState, which can be created with initSyncState()");var _t68 = t,
              n = _t68.sharedHeads,
              r = _t68.lastSentHeads,
              o = _t68.theirHeads,
              a = _t68.theirNeed,
              i = _t68.theirHave,
              u = _t68.sentHashes;
          var h = s.getHeads(e),
              p = s.getMissingDeps(e, o || []);var g = [];if (o && !p.every(function (e) {
            return o.includes(e);
          }) || (g = [b(e, n)]), i && i.length > 0 && !i[0].lastSync.every(function (t) {
            return s.getChangeByHash(e, t);
          })) return [t, f({ heads: h, need: [], have: [{ lastSync: [], bloom: new Uint8Array(0) }], changes: [] })];var y = Array.isArray(i) && Array.isArray(a) ? function (e, t, n) {
            if (0 === t.length) return n.map(function (t) {
              return s.getChangeByHash(e, t);
            }).filter(function (e) {
              return void 0 !== e;
            });var r = {},
                o = [];var _iteratorNormalCompletion72 = true;
            var _didIteratorError72 = false;
            var _iteratorError72 = undefined;

            try {
              for (var _iterator72 = t[Symbol.iterator](), _step72; !(_iteratorNormalCompletion72 = (_step72 = _iterator72.next()).done); _iteratorNormalCompletion72 = true) {
                var _e78 = _step72.value;
                var _iteratorNormalCompletion77 = true;
                var _didIteratorError77 = false;
                var _iteratorError77 = undefined;

                try {
                  for (var _iterator77 = _e78.lastSync[Symbol.iterator](), _step77; !(_iteratorNormalCompletion77 = (_step77 = _iterator77.next()).done); _iteratorNormalCompletion77 = true) {
                    var _t71 = _step77.value;
                    r[_t71] = !0;
                  }
                } catch (err) {
                  _didIteratorError77 = true;
                  _iteratorError77 = err;
                } finally {
                  try {
                    if (!_iteratorNormalCompletion77 && _iterator77.return) {
                      _iterator77.return();
                    }
                  } finally {
                    if (_didIteratorError77) {
                      throw _iteratorError77;
                    }
                  }
                }

                o.push(new d(_e78.bloom));
              }
            } catch (err) {
              _didIteratorError72 = true;
              _iteratorError72 = err;
            } finally {
              try {
                if (!_iteratorNormalCompletion72 && _iterator72.return) {
                  _iterator72.return();
                }
              } finally {
                if (_didIteratorError72) {
                  throw _iteratorError72;
                }
              }
            }

            var a = s.getChanges(e, Object.keys(r)).map(function (e) {
              return l(e, !0);
            });var i = {},
                c = {},
                u = {};
            var _loop2 = function _loop2(_e79) {
              i[_e79.hash] = !0;var _iteratorNormalCompletion78 = true;
              var _didIteratorError78 = false;
              var _iteratorError78 = undefined;

              try {
                for (var _iterator78 = _e79.deps[Symbol.iterator](), _step78; !(_iteratorNormalCompletion78 = (_step78 = _iterator78.next()).done); _iteratorNormalCompletion78 = true) {
                  var _t72 = _step78.value;
                  c[_t72] || (c[_t72] = []), c[_t72].push(_e79.hash);
                }
              } catch (err) {
                _didIteratorError78 = true;
                _iteratorError78 = err;
              } finally {
                try {
                  if (!_iteratorNormalCompletion78 && _iterator78.return) {
                    _iterator78.return();
                  }
                } finally {
                  if (_didIteratorError78) {
                    throw _iteratorError78;
                  }
                }
              }

              o.every(function (t) {
                return !t.containsHash(_e79.hash);
              }) && (u[_e79.hash] = !0);
            };

            var _iteratorNormalCompletion73 = true;
            var _didIteratorError73 = false;
            var _iteratorError73 = undefined;

            try {
              for (var _iterator73 = a[Symbol.iterator](), _step73; !(_iteratorNormalCompletion73 = (_step73 = _iterator73.next()).done); _iteratorNormalCompletion73 = true) {
                var _e79 = _step73.value;

                _loop2(_e79);
              }
            } catch (err) {
              _didIteratorError73 = true;
              _iteratorError73 = err;
            } finally {
              try {
                if (!_iteratorNormalCompletion73 && _iterator73.return) {
                  _iterator73.return();
                }
              } finally {
                if (_didIteratorError73) {
                  throw _iteratorError73;
                }
              }
            }

            var h = Object.keys(u);for (; h.length > 0;) {
              var _e80 = h.pop();if (c[_e80]) {
                var _iteratorNormalCompletion74 = true;
                var _didIteratorError74 = false;
                var _iteratorError74 = undefined;

                try {
                  for (var _iterator74 = c[_e80][Symbol.iterator](), _step74; !(_iteratorNormalCompletion74 = (_step74 = _iterator74.next()).done); _iteratorNormalCompletion74 = true) {
                    var _t69 = _step74.value;
                    u[_t69] || (u[_t69] = !0, h.push(_t69));
                  }
                } catch (err) {
                  _didIteratorError74 = true;
                  _iteratorError74 = err;
                } finally {
                  try {
                    if (!_iteratorNormalCompletion74 && _iterator74.return) {
                      _iterator74.return();
                    }
                  } finally {
                    if (_didIteratorError74) {
                      throw _iteratorError74;
                    }
                  }
                }
              }
            }var f = [];var _iteratorNormalCompletion75 = true;
            var _didIteratorError75 = false;
            var _iteratorError75 = undefined;

            try {
              for (var _iterator75 = n[Symbol.iterator](), _step75; !(_iteratorNormalCompletion75 = (_step75 = _iterator75.next()).done); _iteratorNormalCompletion75 = true) {
                var _t70 = _step75.value;
                if (u[_t70] = !0, !i[_t70]) {
                  var _n63 = s.getChangeByHash(e, _t70);_n63 && f.push(_n63);
                }
              }
            } catch (err) {
              _didIteratorError75 = true;
              _iteratorError75 = err;
            } finally {
              try {
                if (!_iteratorNormalCompletion75 && _iterator75.return) {
                  _iterator75.return();
                }
              } finally {
                if (_didIteratorError75) {
                  throw _iteratorError75;
                }
              }
            }

            var _iteratorNormalCompletion76 = true;
            var _didIteratorError76 = false;
            var _iteratorError76 = undefined;

            try {
              for (var _iterator76 = a[Symbol.iterator](), _step76; !(_iteratorNormalCompletion76 = (_step76 = _iterator76.next()).done); _iteratorNormalCompletion76 = true) {
                var _e81 = _step76.value;
                u[_e81.hash] && f.push(_e81.change);
              }
            } catch (err) {
              _didIteratorError76 = true;
              _iteratorError76 = err;
            } finally {
              try {
                if (!_iteratorNormalCompletion76 && _iterator76.return) {
                  _iterator76.return();
                }
              } finally {
                if (_didIteratorError76) {
                  throw _iteratorError76;
                }
              }
            }

            return f;
          }(e, i, a) : [];var w = Array.isArray(r) && m(h, r),
              _ = Array.isArray(o) && m(h, o);if (w && _ && 0 === y.length) return [t, null];y = y.filter(function (e) {
            return !u[l(e, !0).hash];
          });var I = { heads: h, have: g, need: p, changes: y };if (y.length > 0) {
            u = c(u);var _iteratorNormalCompletion79 = true;
            var _didIteratorError79 = false;
            var _iteratorError79 = undefined;

            try {
              for (var _iterator79 = y[Symbol.iterator](), _step79; !(_iteratorNormalCompletion79 = (_step79 = _iterator79.next()).done); _iteratorNormalCompletion79 = true) {
                var _e82 = _step79.value;
                u[l(_e82, !0).hash] = !0;
              }
            } catch (err) {
              _didIteratorError79 = true;
              _iteratorError79 = err;
            } finally {
              try {
                if (!_iteratorNormalCompletion79 && _iterator79.return) {
                  _iterator79.return();
                }
              } finally {
                if (_didIteratorError79) {
                  throw _iteratorError79;
                }
              }
            }
          }return [t = Object.assign({}, t, { lastSentHeads: h, sentHashes: u }), f(I)];
        }, encodeSyncMessage: f, decodeSyncMessage: p, initSyncState: g, encodeSyncState: function encodeSyncState(e) {
          var t = new a();return t.appendByte(67), u(t, e.sharedHeads), t.buffer;
        }, decodeSyncState: function decodeSyncState(e) {
          var t = new i(e),
              n = t.readByte();if (67 !== n) throw new RangeError("Unexpected record type: " + n);var s = h(t);return Object.assign({ sharedHeads: [], lastSentHeads: [], theirHeads: null, theirNeed: null, theirHave: null, sentHashes: {} }, { sharedHeads: s });
        }, BloomFilter: d };
    }, "./backend/util.js":
    /*!*************************!*\
      !*** ./backend/util.js ***!
      \*************************/function backendUtilJs(e) {
      e.exports = { backendState: function backendState(e) {
          if (e.frozen) throw new Error("Attempting to use an outdated Automerge document that has already been updated. Please use the latest document state, or call Automerge.clone() if you really need to use this old document state.");return e.state;
        } };
    }, "./frontend/apply_patch.js":
    /*!*********************************!*\
      !*** ./frontend/apply_patch.js ***!
      \*********************************/function frontendApply_patchJs(e, t, n) {
      var _n64 = n( /*! ../src/common */"./src/common.js"),
          s = _n64.isObject,
          r = _n64.copyObject,
          o = _n64.parseOpId,
          _n65 = n( /*! ./constants */"./frontend/constants.js"),
          a = _n65.OBJECT_ID,
          i = _n65.CONFLICTS,
          l = _n65.ELEM_IDS,
          _n66 = n( /*! ./text */"./frontend/text.js"),
          c = _n66.instantiateText,
          _n67 = n( /*! ./table */"./frontend/table.js"),
          d = _n67.instantiateTable,
          _n68 = n( /*! ./counter */"./frontend/counter.js"),
          u = _n68.Counter;

      function h(e, t, n) {
        return e.objectId ? (t && t[a] !== e.objectId && (t = void 0), m(e, t, n)) : "timestamp" === e.datatype ? new Date(e.value) : "counter" === e.datatype ? new u(e.value) : e.value;
      }function f(e, t) {
        var n = /^(\d+)@(.*)$/,
            s = n.test(e) ? o(e) : { counter: 0, actorId: e },
            r = n.test(t) ? o(t) : { counter: 0, actorId: t };return s.counter < r.counter ? -1 : s.counter > r.counter ? 1 : s.actorId < r.actorId ? -1 : s.actorId > r.actorId ? 1 : 0;
      }function p(e, t) {
        var n = r(e),
            s = r(e ? e[i] : void 0);return Object.defineProperty(n, a, { value: t }), Object.defineProperty(n, i, { value: s }), n;
      }function b(e, t, n) {
        var s = e.objectId;n[s] || (n[s] = p(t, s));var r = n[s];return function (e, t, n, s) {
          if (e) {
            var _iteratorNormalCompletion80 = true;
            var _didIteratorError80 = false;
            var _iteratorError80 = undefined;

            try {
              for (var _iterator80 = Object.keys(e)[Symbol.iterator](), _step80; !(_iteratorNormalCompletion80 = (_step80 = _iterator80.next()).done); _iteratorNormalCompletion80 = true) {
                var _r19 = _step80.value;
                var _o17 = {},
                    _a12 = Object.keys(e[_r19]).sort(f).reverse();var _iteratorNormalCompletion81 = true;
                var _didIteratorError81 = false;
                var _iteratorError81 = undefined;

                try {
                  for (var _iterator81 = _a12[Symbol.iterator](), _step81; !(_iteratorNormalCompletion81 = (_step81 = _iterator81.next()).done); _iteratorNormalCompletion81 = true) {
                    var _t73 = _step81.value;
                    var _a13 = e[_r19][_t73];n[_r19] && n[_r19][_t73] ? _o17[_t73] = h(_a13, n[_r19][_t73], s) : _o17[_t73] = h(_a13, void 0, s);
                  }
                } catch (err) {
                  _didIteratorError81 = true;
                  _iteratorError81 = err;
                } finally {
                  try {
                    if (!_iteratorNormalCompletion81 && _iterator81.return) {
                      _iterator81.return();
                    }
                  } finally {
                    if (_didIteratorError81) {
                      throw _iteratorError81;
                    }
                  }
                }

                0 === _a12.length ? (delete t[_r19], delete n[_r19]) : (t[_r19] = _o17[_a12[0]], n[_r19] = _o17);
              }
            } catch (err) {
              _didIteratorError80 = true;
              _iteratorError80 = err;
            } finally {
              try {
                if (!_iteratorNormalCompletion80 && _iterator80.return) {
                  _iterator80.return();
                }
              } finally {
                if (_didIteratorError80) {
                  throw _iteratorError80;
                }
              }
            }
          }
        }(e.props, r, r[i], n), r;
      }function g(e, t, n) {
        var s = e.objectId;n[s] || (n[s] = function (e, t) {
          var n = e ? e.slice() : [],
              s = e && e[i] ? e[i].slice() : [],
              r = e && e[l] ? e[l].slice() : [];return Object.defineProperty(n, a, { value: t }), Object.defineProperty(n, i, { value: s }), Object.defineProperty(n, l, { value: r }), n;
        }(t, s));var r = n[s],
            c = r[i],
            d = r[l];for (var _t74 = 0; _t74 < e.edits.length; _t74++) {
          var _s35 = e.edits[_t74];if ("insert" === _s35.action || "update" === _s35.action) {
            var _o18 = c[_s35.index] && c[_s35.index][_s35.opId];var _a14 = h(_s35.value, _o18, n),
                _i10 = _defineProperty({}, _s35.opId, _a14);for (; _t74 < e.edits.length - 1 && e.edits[_t74 + 1].index === _s35.index && "update" === e.edits[_t74 + 1].action;) {
              _t74++;var _s36 = e.edits[_t74],
                  _r20 = c[_s36.index] && c[_s36.index][_s36.opId];_a14 = h(_s36.value, _r20, n), _i10[_s36.opId] = _a14;
            }"insert" === _s35.action ? (r.splice(_s35.index, 0, _a14), c.splice(_s35.index, 0, _i10), d.splice(_s35.index, 0, _s35.elemId)) : (r[_s35.index] = _a14, c[_s35.index] = _i10);
          } else if ("multi-insert" === _s35.action) {
            (function () {
              var e = o(_s35.elemId),
                  t = [],
                  a = [],
                  i = [],
                  l = _s35.datatype;_s35.values.forEach(function (s, r) {
                var o = e.counter + r + "@" + e.actorId;s = h({ value: s, datatype: l }, void 0, n), a.push(s), i.push(_defineProperty({}, o, { value: s, datatype: l, type: "value" })), t.push(o);
              }), r.splice.apply(r, [_s35.index, 0].concat(a)), c.splice.apply(c, [_s35.index, 0].concat(i)), d.splice.apply(d, [_s35.index, 0].concat(t));
            })();
          } else "remove" === _s35.action && (r.splice(_s35.index, _s35.count), c.splice(_s35.index, _s35.count), d.splice(_s35.index, _s35.count));
        }return r;
      }function m(e, t, n) {
        if (s(t) && (!e.props || 0 === Object.keys(e.props).length) && (!e.edits || 0 === e.edits.length) && !n[e.objectId]) return t;if ("map" === e.type) return b(e, t, n);if ("table" === e.type) return function (e, t, n) {
          var s = e.objectId;n[s] || (n[s] = t ? t._clone() : d(s));var r = n[s];var _iteratorNormalCompletion82 = true;
          var _didIteratorError82 = false;
          var _iteratorError82 = undefined;

          try {
            for (var _iterator82 = Object.keys(e.props || {})[Symbol.iterator](), _step82; !(_iteratorNormalCompletion82 = (_step82 = _iterator82.next()).done); _iteratorNormalCompletion82 = true) {
              var _t75 = _step82.value;
              var _s37 = Object.keys(e.props[_t75]);if (0 === _s37.length) r.remove(_t75);else {
                if (1 !== _s37.length) throw new RangeError("Conflicts are not supported on properties of a table");{
                  var _o19 = e.props[_t75][_s37[0]];r._set(_t75, h(_o19, r.byId(_t75), n), _s37[0]);
                }
              }
            }
          } catch (err) {
            _didIteratorError82 = true;
            _iteratorError82 = err;
          } finally {
            try {
              if (!_iteratorNormalCompletion82 && _iterator82.return) {
                _iterator82.return();
              }
            } finally {
              if (_didIteratorError82) {
                throw _iteratorError82;
              }
            }
          }

          return r;
        }(e, t, n);if ("list" === e.type) return g(e, t, n);if ("text" === e.type) return function (e, t, n) {
          var s = e.objectId;var r = void 0;r = n[s] ? n[s].elems : t ? t.elems.slice() : [];var _iteratorNormalCompletion83 = true;
          var _didIteratorError83 = false;
          var _iteratorError83 = undefined;

          try {
            for (var _iterator83 = e.edits[Symbol.iterator](), _step83; !(_iteratorNormalCompletion83 = (_step83 = _iterator83.next()).done); _iteratorNormalCompletion83 = true) {
              var _t76 = _step83.value;
              if ("insert" === _t76.action) {
                var _e83 = h(_t76.value, void 0, n),
                    _s38 = { elemId: _t76.elemId, pred: [_t76.opId], value: _e83 };r.splice(_t76.index, 0, _s38);
              } else if ("multi-insert" === _t76.action) {
                (function () {
                  var _r21;

                  var e = o(_t76.elemId),
                      s = _t76.datatype,
                      a = _t76.values.map(function (t, r) {
                    t = h({ datatype: s, value: t }, void 0, n);var o = e.counter + r + "@" + e.actorId;return { elemId: o, pred: [o], value: t };
                  });(_r21 = r).splice.apply(_r21, [_t76.index, 0].concat(_toConsumableArray(a)));
                })();
              } else if ("update" === _t76.action) {
                var _e84 = r[_t76.index].elemId,
                    _s39 = h(_t76.value, r[_t76.index].value, n);r[_t76.index] = { elemId: _e84, pred: [_t76.opId], value: _s39 };
              } else "remove" === _t76.action && r.splice(_t76.index, _t76.count);
            }
          } catch (err) {
            _didIteratorError83 = true;
            _iteratorError83 = err;
          } finally {
            try {
              if (!_iteratorNormalCompletion83 && _iterator83.return) {
                _iterator83.return();
              }
            } finally {
              if (_didIteratorError83) {
                throw _iteratorError83;
              }
            }
          }

          return n[s] = c(s, r), n[s];
        }(e, t, n);throw new TypeError("Unknown object type: " + e.type);
      }e.exports = { interpretPatch: m, cloneRootObject: function cloneRootObject(e) {
          if ("_root" !== e[a]) throw new RangeError("Not the root object: " + e[a]);return p(e, "_root");
        } };
    }, "./frontend/constants.js":
    /*!*******************************!*\
      !*** ./frontend/constants.js ***!
      \*******************************/function frontendConstantsJs(e) {
      var t = Symbol("_options"),
          n = Symbol("_cache"),
          s = Symbol("_state"),
          r = Symbol("_objectId"),
          o = Symbol("_conflicts"),
          a = Symbol("_change"),
          i = Symbol("_elemIds");e.exports = { OPTIONS: t, CACHE: n, STATE: s, OBJECT_ID: r, CONFLICTS: o, CHANGE: a, ELEM_IDS: i };
    }, "./frontend/context.js":
    /*!*****************************!*\
      !*** ./frontend/context.js ***!
      \*****************************/function frontendContextJs(e, t, n) {
      var _n69 = n( /*! ./constants */"./frontend/constants.js"),
          s = _n69.CACHE,
          r = _n69.OBJECT_ID,
          o = _n69.CONFLICTS,
          a = _n69.ELEM_IDS,
          i = _n69.STATE,
          _n70 = n( /*! ./apply_patch */"./frontend/apply_patch.js"),
          l = _n70.interpretPatch,
          _n71 = n( /*! ./text */"./frontend/text.js"),
          c = _n71.Text,
          _n72 = n( /*! ./table */"./frontend/table.js"),
          d = _n72.Table,
          _n73 = n( /*! ./counter */"./frontend/counter.js"),
          u = _n73.Counter,
          h = _n73.getWriteableCounter,
          _n74 = n( /*! ./numbers */"./frontend/numbers.js"),
          f = _n74.Int,
          p = _n74.Uint,
          b = _n74.Float64,
          _n75 = n( /*! ../src/common */"./src/common.js"),
          g = _n75.isObject,
          m = _n75.parseOpId,
          y = _n75.createArrayOfNulls,
          w = n( /*! ../src/uuid */"./src/uuid.js");

      function _(e, t) {
        return e instanceof d ? [e.opIds[t]] : e instanceof c ? e.elems[t].pred : e[o] && e[o][t] ? Object.keys(e[o][t]) : [];
      }function I(e, t) {
        var n = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : !1;
        if (n) {
          if (0 === t) return "_head";t -= 1;
        }if (e[a]) return e[a][t];if (e.getElemId) return e.getElemId(t);throw new RangeError("Cannot find elemId at list index " + t);
      }e.exports = { Context: function () {
          function Context(e, t, n) {
            _classCallCheck(this, Context);

            this.actorId = t, this.nextOpNum = e[i].maxOp + 1, this.cache = e[s], this.updated = {}, this.ops = [], this.applyPatch = n || l;
          }

          _createClass(Context, [{
            key: "addOp",
            value: function addOp(e) {
              this.ops.push(e), "set" === e.action && e.values ? this.nextOpNum += e.values.length : "del" === e.action && e.multiOp ? this.nextOpNum += e.multiOp : this.nextOpNum += 1;
            }
          }, {
            key: "nextOpId",
            value: function nextOpId() {
              return this.nextOpNum + "@" + this.actorId;
            }
          }, {
            key: "getValueDescription",
            value: function getValueDescription(e) {
              if (!["object", "boolean", "number", "string"].includes(typeof e === "undefined" ? "undefined" : _typeof(e))) throw new TypeError("Unsupported type of value: " + (typeof e === "undefined" ? "undefined" : _typeof(e)));if (g(e)) {
                if (e instanceof Date) return { type: "value", value: e.getTime(), datatype: "timestamp" };if (e instanceof f) return { type: "value", value: e.value, datatype: "int" };if (e instanceof p) return { type: "value", value: e.value, datatype: "uint" };if (e instanceof b) return { type: "value", value: e.value, datatype: "float64" };if (e instanceof u) return { type: "value", value: e.value, datatype: "counter" };{
                  var _t77 = e[r],
                      _n76 = this.getObjectType(_t77);if (!_t77) throw new RangeError("Object " + JSON.stringify(e) + " has no objectId");return "list" === _n76 || "text" === _n76 ? { objectId: _t77, type: _n76, edits: [] } : { objectId: _t77, type: _n76, props: {} };
                }
              }return "number" == typeof e ? Number.isInteger(e) && e <= Number.MAX_SAFE_INTEGER && e >= Number.MIN_SAFE_INTEGER ? { type: "value", value: e, datatype: "int" } : { type: "value", value: e, datatype: "float64" } : { type: "value", value: e };
            }
          }, {
            key: "getValuesDescriptions",
            value: function getValuesDescriptions(e, t, n) {
              if (t instanceof d) {
                var _e85 = t.byId(n),
                    _s40 = t.opIds[n];return _e85 ? _defineProperty({}, _s40, this.getValueDescription(_e85)) : {};
              }if (t instanceof c) {
                var _e86 = t.get(n),
                    _s41 = t.getElemId(n);return _e86 ? _defineProperty({}, _s41, this.getValueDescription(_e86)) : {};
              }{
                var _s42 = t[o][n],
                    _r22 = {};if (!_s42) throw new RangeError("No children at key " + n + " of path " + JSON.stringify(e));var _iteratorNormalCompletion84 = true;
                var _didIteratorError84 = false;
                var _iteratorError84 = undefined;

                try {
                  for (var _iterator84 = Object.keys(_s42)[Symbol.iterator](), _step84; !(_iteratorNormalCompletion84 = (_step84 = _iterator84.next()).done); _iteratorNormalCompletion84 = true) {
                    var _e87 = _step84.value;
                    _r22[_e87] = this.getValueDescription(_s42[_e87]);
                  }
                } catch (err) {
                  _didIteratorError84 = true;
                  _iteratorError84 = err;
                } finally {
                  try {
                    if (!_iteratorNormalCompletion84 && _iterator84.return) {
                      _iterator84.return();
                    }
                  } finally {
                    if (_didIteratorError84) {
                      throw _iteratorError84;
                    }
                  }
                }

                return _r22;
              }
            }
          }, {
            key: "getPropertyValue",
            value: function getPropertyValue(e, t, n) {
              return e instanceof d ? e.byId(t) : e instanceof c ? e.get(t) : e[o][t][n];
            }
          }, {
            key: "getSubpatch",
            value: function getSubpatch(e, t) {
              if (0 == t.length) return e;var n = e,
                  s = this.getObject("_root");var _iteratorNormalCompletion85 = true;
              var _didIteratorError85 = false;
              var _iteratorError85 = undefined;

              try {
                for (var _iterator85 = t[Symbol.iterator](), _step85; !(_iteratorNormalCompletion85 = (_step85 = _iterator85.next()).done); _iteratorNormalCompletion85 = true) {
                  var _e88 = _step85.value;
                  var _r23 = this.getValuesDescriptions(t, s, _e88.key);if (n.props) n.props[_e88.key] || (n.props[_e88.key] = _r23);else if (n.edits) {
                    var _iteratorNormalCompletion86 = true;
                    var _didIteratorError86 = false;
                    var _iteratorError86 = undefined;

                    try {
                      for (var _iterator86 = Object.keys(_r23)[Symbol.iterator](), _step86; !(_iteratorNormalCompletion86 = (_step86 = _iterator86.next()).done); _iteratorNormalCompletion86 = true) {
                        var _t78 = _step86.value;
                        n.edits.push({ action: "update", index: _e88.key, opId: _t78, value: _r23[_t78] });
                      }
                    } catch (err) {
                      _didIteratorError86 = true;
                      _iteratorError86 = err;
                    } finally {
                      try {
                        if (!_iteratorNormalCompletion86 && _iterator86.return) {
                          _iterator86.return();
                        }
                      } finally {
                        if (_didIteratorError86) {
                          throw _iteratorError86;
                        }
                      }
                    }
                  }var _o20 = null;var _iteratorNormalCompletion87 = true;
                  var _didIteratorError87 = false;
                  var _iteratorError87 = undefined;

                  try {
                    for (var _iterator87 = Object.keys(_r23)[Symbol.iterator](), _step87; !(_iteratorNormalCompletion87 = (_step87 = _iterator87.next()).done); _iteratorNormalCompletion87 = true) {
                      var _t79 = _step87.value;
                      _r23[_t79].objectId === _e88.objectId && (_o20 = _t79);
                    }
                  } catch (err) {
                    _didIteratorError87 = true;
                    _iteratorError87 = err;
                  } finally {
                    try {
                      if (!_iteratorNormalCompletion87 && _iterator87.return) {
                        _iterator87.return();
                      }
                    } finally {
                      if (_didIteratorError87) {
                        throw _iteratorError87;
                      }
                    }
                  }

                  if (!_o20) throw new RangeError("Cannot find path object with objectId " + _e88.objectId);n = _r23[_o20], s = this.getPropertyValue(s, _e88.key, _o20);
                }
              } catch (err) {
                _didIteratorError85 = true;
                _iteratorError85 = err;
              } finally {
                try {
                  if (!_iteratorNormalCompletion85 && _iterator85.return) {
                    _iterator85.return();
                  }
                } finally {
                  if (_didIteratorError85) {
                    throw _iteratorError85;
                  }
                }
              }

              return n;
            }
          }, {
            key: "getObject",
            value: function getObject(e) {
              var t = this.updated[e] || this.cache[e];if (!t) throw new RangeError("Target object does not exist: " + e);return t;
            }
          }, {
            key: "getObjectType",
            value: function getObjectType(e) {
              if ("_root" === e) return "map";var t = this.getObject(e);return t instanceof c ? "text" : t instanceof d ? "table" : Array.isArray(t) ? "list" : "map";
            }
          }, {
            key: "getObjectField",
            value: function getObjectField(e, t, n) {
              if (!["string", "number"].includes(typeof n === "undefined" ? "undefined" : _typeof(n))) return;var s = this.getObject(t);if (s[n] instanceof u) return h(s[n].value, this, e, t, n);if (g(s[n])) {
                var _t80 = s[n][r],
                    _o21 = e.concat([{ key: n, objectId: _t80 }]);return this.instantiateObject(_o21, _t80);
              }return s[n];
            }
          }, {
            key: "createNestedObjects",
            value: function createNestedObjects(e, t, n, s, o, a) {
              if (n[r]) throw new RangeError("Cannot create a reference to an existing document object");var i = this.nextOpId();if (n instanceof c) {
                this.addOp(a ? { action: "makeText", obj: e, elemId: a, insert: s, pred: o } : { action: "makeText", obj: e, key: t, insert: s, pred: o });var _r24 = { objectId: i, type: "text", edits: [] };return this.insertListItems(_r24, 0, [].concat(_toConsumableArray(n)), !0), _r24;
              }if (n instanceof d) {
                if (n.count > 0) throw new RangeError("Assigning a non-empty Table object is not supported");return this.addOp(a ? { action: "makeTable", obj: e, elemId: a, insert: s, pred: o } : { action: "makeTable", obj: e, key: t, insert: s, pred: o }), { objectId: i, type: "table", props: {} };
              }if (Array.isArray(n)) {
                this.addOp(a ? { action: "makeList", obj: e, elemId: a, insert: s, pred: o } : { action: "makeList", obj: e, key: t, insert: s, pred: o });var _r25 = { objectId: i, type: "list", edits: [] };return this.insertListItems(_r25, 0, n, !0), _r25;
              }{
                this.addOp(a ? { action: "makeMap", obj: e, elemId: a, insert: s, pred: o } : { action: "makeMap", obj: e, key: t, insert: s, pred: o });var _r26 = {};var _iteratorNormalCompletion88 = true;
                var _didIteratorError88 = false;
                var _iteratorError88 = undefined;

                try {
                  for (var _iterator88 = Object.keys(n).sort()[Symbol.iterator](), _step88; !(_iteratorNormalCompletion88 = (_step88 = _iterator88.next()).done); _iteratorNormalCompletion88 = true) {
                    var _e89 = _step88.value;
                    var _t81 = this.nextOpId(),
                        _s43 = this.setValue(i, _e89, n[_e89], !1, []);_r26[_e89] = _defineProperty({}, _t81, _s43);
                  }
                } catch (err) {
                  _didIteratorError88 = true;
                  _iteratorError88 = err;
                } finally {
                  try {
                    if (!_iteratorNormalCompletion88 && _iterator88.return) {
                      _iterator88.return();
                    }
                  } finally {
                    if (_didIteratorError88) {
                      throw _iteratorError88;
                    }
                  }
                }

                return { objectId: i, type: "map", props: _r26 };
              }
            }
          }, {
            key: "setValue",
            value: function setValue(e, t, n, s, r, o) {
              if (!e) throw new RangeError("setValue needs an objectId");if ("" === t) throw new RangeError("The key of a map entry must not be an empty string");if (!g(n) || n instanceof Date || n instanceof u || n instanceof f || n instanceof p || n instanceof b) {
                var _a15 = this.getValueDescription(n),
                    _i12 = { action: "set", obj: e, insert: s, value: _a15.value, pred: r };return o ? _i12.elemId = o : _i12.key = t, _a15.datatype && (_i12.datatype = _a15.datatype), this.addOp(_i12), _a15;
              }return this.createNestedObjects(e, t, n, s, r, o);
            }
          }, {
            key: "applyAtPath",
            value: function applyAtPath(e, t) {
              var n = { objectId: "_root", type: "map", props: {} };t(this.getSubpatch(n, e)), this.applyPatch(n, this.cache._root, this.updated);
            }
          }, {
            key: "setMapKey",
            value: function setMapKey(e, t, n) {
              var _this10 = this;

              if ("string" != typeof t) throw new RangeError("The key of a map entry must be a string, not " + (typeof t === "undefined" ? "undefined" : _typeof(t)));var s = 0 === e.length ? "_root" : e[e.length - 1].objectId,
                  r = this.getObject(s);if (r[t] instanceof u) throw new RangeError("Cannot overwrite a Counter object; use .increment() or .decrement() to change its value.");(r[t] !== n || Object.keys(r[o][t] || {}).length > 1 || void 0 === n) && this.applyAtPath(e, function (e) {
                var o = _(r, t),
                    a = _this10.nextOpId(),
                    i = _this10.setValue(s, t, n, !1, o);e.props[t] = _defineProperty({}, a, i);
              });
            }
          }, {
            key: "deleteMapKey",
            value: function deleteMapKey(e, t) {
              var n = 0 === e.length ? "_root" : e[e.length - 1].objectId,
                  s = this.getObject(n);if (void 0 !== s[t]) {
                var _r27 = _(s, t);this.addOp({ action: "del", obj: n, key: t, insert: !1, pred: _r27 }), this.applyAtPath(e, function (e) {
                  e.props[t] = {};
                });
              }
            }
          }, {
            key: "insertListItems",
            value: function insertListItems(e, t, n, s) {
              var _this11 = this;

              var r = s ? [] : this.getObject(e.objectId);if (t < 0 || t > r.length) throw new RangeError("List index " + t + " is out of bounds for list of length " + r.length);if (0 === n.length) return;var o = I(r, t, !0);var a = n.every(function (e) {
                return "string" == typeof e || "number" == typeof e || "boolean" == typeof e || null === e || g(e) && (e instanceof Date || e instanceof u || e instanceof f || e instanceof p || e instanceof b);
              }),
                  i = a ? n.map(function (e) {
                return _this11.getValueDescription(e);
              }) : [],
                  l = i.every(function (e) {
                return e.datatype === i[0].datatype;
              });if (a && l && n.length > 1) {
                var _n77 = this.nextOpId(),
                    _s44 = i[0].datatype,
                    _r28 = i.map(function (e) {
                  return e.value;
                }),
                    _a16 = { action: "set", obj: e.objectId, elemId: o, insert: !0, values: _r28, pred: [] },
                    _l3 = { action: "multi-insert", elemId: _n77, index: t, values: _r28 };_s44 && (_a16.datatype = _s44, _l3.datatype = _s44), this.addOp(_a16), e.edits.push(_l3);
              } else for (var _s45 = 0; _s45 < n.length; _s45++) {
                var _r29 = this.nextOpId();var _a17 = this.setValue(e.objectId, t + _s45, n[_s45], !0, [], o);o = _r29, e.edits.push({ action: "insert", index: t + _s45, elemId: o, opId: o, value: _a17 });
              }
            }
          }, {
            key: "setListIndex",
            value: function setListIndex(e, t, n) {
              var _this12 = this;

              var s = 0 === e.length ? "_root" : e[e.length - 1].objectId,
                  r = this.getObject(s);if (t >= r.length) {
                var _s46 = y(t - r.length);return _s46.push(n), this.splice(e, r.length, 0, _s46);
              }if (r[t] instanceof u) throw new RangeError("Cannot overwrite a Counter object; use .increment() or .decrement() to change its value.");(r[t] !== n || Object.keys(r[o][t] || {}).length > 1 || void 0 === n) && this.applyAtPath(e, function (e) {
                var o = _(r, t),
                    a = _this12.nextOpId(),
                    i = _this12.setValue(s, t, n, !1, o, I(r, t));e.edits.push({ action: "update", index: t, opId: a, value: i });
              });
            }
          }, {
            key: "splice",
            value: function splice(e, t, n, s) {
              var r = 0 === e.length ? "_root" : e[e.length - 1].objectId;var o = this.getObject(r);if (t < 0 || n < 0 || t > o.length - n) throw new RangeError(n + " deletions starting at index " + t + " are out of bounds for list of length " + o.length);if (0 === n && 0 === s.length) return;var a = { objectId: "_root", type: "map", props: {} },
                  i = this.getSubpatch(a, e);if (n > 0) {
                var _s47 = void 0,
                    _a18 = void 0,
                    _l4 = void 0;for (var _i13 = 0; _i13 < n; _i13++) {
                  if (this.getObjectField(e, r, t + _i13) instanceof u) throw new TypeError("Unsupported operation: deleting a counter from a list");var _n78 = I(o, t + _i13),
                      _c6 = m(_n78),
                      _d8 = _(o, t + _i13),
                      _h5 = 1 === _d8.length ? m(_d8[0]) : void 0;_s47 && _a18 && _l4 && _h5 && _a18.actorId === _c6.actorId && _a18.counter + 1 === _c6.counter && _l4.actorId === _h5.actorId && _l4.counter + 1 === _h5.counter ? _s47.multiOp = (_s47.multiOp || 1) + 1 : (_s47 && this.addOp(_s47), _s47 = { action: "del", obj: r, elemId: _n78, insert: !1, pred: _d8 }), _a18 = _c6, _l4 = _h5;
                }this.addOp(_s47), i.edits.push({ action: "remove", index: t, count: n });
              }s.length > 0 && this.insertListItems(i, t, s, !1), this.applyPatch(a, this.cache._root, this.updated);
            }
          }, {
            key: "addTableRow",
            value: function addTableRow(e, t) {
              if (!g(t) || Array.isArray(t)) throw new TypeError("A table row must be an object");if (t[r]) throw new TypeError("Cannot reuse an existing object as table row");if (t.id) throw new TypeError('A table row must not have an "id" property; it is generated automatically');var n = w(),
                  s = this.setValue(e[e.length - 1].objectId, n, t, !1, []);return this.applyAtPath(e, function (e) {
                e.props[n] = _defineProperty({}, s.objectId, s);
              }), n;
            }
          }, {
            key: "deleteTableRow",
            value: function deleteTableRow(e, t, n) {
              var s = e[e.length - 1].objectId;this.getObject(s).byId(t) && (this.addOp({ action: "del", obj: s, key: t, insert: !1, pred: [n] }), this.applyAtPath(e, function (e) {
                e.props[t] = {};
              }));
            }
          }, {
            key: "increment",
            value: function increment(e, t, n) {
              var s = 0 === e.length ? "_root" : e[e.length - 1].objectId,
                  r = this.getObject(s);if (!(r[t] instanceof u)) throw new TypeError("Only counter values can be incremented");var o = this.getObjectType(s),
                  a = r[t].value + n,
                  i = this.nextOpId(),
                  l = _(r, t);if ("list" === o || "text" === o) {
                var _e90 = I(r, t, !1);this.addOp({ action: "inc", obj: s, elemId: _e90, value: n, insert: !1, pred: l });
              } else this.addOp({ action: "inc", obj: s, key: t, value: n, insert: !1, pred: l });this.applyAtPath(e, function (e) {
                "list" === o || "text" === o ? e.edits.push({ action: "update", index: t, opId: i, value: { value: a, datatype: "counter" } }) : e.props[t] = _defineProperty({}, i, { value: a, datatype: "counter" });
              });
            }
          }]);

          return Context;
        }() };
    }, "./frontend/counter.js":
    /*!*****************************!*\
      !*** ./frontend/counter.js ***!
      \*****************************/function frontendCounterJs(e) {
      var t = function () {
        function t(e) {
          _classCallCheck(this, t);

          this.value = e || 0, Object.freeze(this);
        }

        _createClass(t, [{
          key: "valueOf",
          value: function valueOf() {
            return this.value;
          }
        }, {
          key: "toString",
          value: function toString() {
            return this.valueOf().toString();
          }
        }, {
          key: "toJSON",
          value: function toJSON() {
            return this.value;
          }
        }]);

        return t;
      }();

      var n = function (_t82) {
        _inherits(n, _t82);

        function n() {
          _classCallCheck(this, n);

          return _possibleConstructorReturn(this, (n.__proto__ || Object.getPrototypeOf(n)).apply(this, arguments));
        }

        _createClass(n, [{
          key: "increment",
          value: function increment(e) {
            return e = "number" == typeof e ? e : 1, this.context.increment(this.path, this.key, e), this.value += e, this.value;
          }
        }, {
          key: "decrement",
          value: function decrement(e) {
            return this.increment("number" == typeof e ? -e : -1);
          }
        }]);

        return n;
      }(t);

      e.exports = { Counter: t, getWriteableCounter: function getWriteableCounter(e, t, s, r, o) {
          var a = Object.create(n.prototype);return a.value = e, a.context = t, a.path = s, a.objectId = r, a.key = o, a;
        } };
    }, "./frontend/index.js":
    /*!***************************!*\
      !*** ./frontend/index.js ***!
      \***************************/function frontendIndexJs(e, t, n) {
      var _n79 = n( /*! ./constants */"./frontend/constants.js"),
          s = _n79.OPTIONS,
          r = _n79.CACHE,
          o = _n79.STATE,
          a = _n79.OBJECT_ID,
          i = _n79.CONFLICTS,
          l = _n79.CHANGE,
          c = _n79.ELEM_IDS,
          _n80 = n( /*! ../src/common */"./src/common.js"),
          d = _n80.isObject,
          u = _n80.copyObject,
          h = n( /*! ../src/uuid */"./src/uuid.js"),
          _n81 = n( /*! ./apply_patch */"./frontend/apply_patch.js"),
          f = _n81.interpretPatch,
          p = _n81.cloneRootObject,
          _n82 = n( /*! ./proxies */"./frontend/proxies.js"),
          b = _n82.rootObjectProxy,
          _n83 = n( /*! ./context */"./frontend/context.js"),
          g = _n83.Context,
          _n84 = n( /*! ./text */"./frontend/text.js"),
          m = _n84.Text,
          _n85 = n( /*! ./table */"./frontend/table.js"),
          y = _n85.Table,
          _n86 = n( /*! ./counter */"./frontend/counter.js"),
          w = _n86.Counter,
          _n87 = n( /*! ./numbers */"./frontend/numbers.js"),
          _ = _n87.Float64,
          I = _n87.Int,
          v = _n87.Uint,
          _n88 = n( /*! ./observable */"./frontend/observable.js"),
          k = _n88.Observable;

      function x(e) {
        if ("string" != typeof e) throw new TypeError("Unsupported type of actorId: " + (typeof e === "undefined" ? "undefined" : _typeof(e)));if (!/^[0-9a-f]+$/.test(e)) throw new RangeError("actorId must consist only of lowercase hex digits");if (e.length % 2 != 0) throw new RangeError("actorId must consist of an even number of digits");
      }function j(e, t, n) {
        var a = t._root;if (a || (a = p(e[r]._root), t._root = a), Object.defineProperty(a, s, { value: e[s] }), Object.defineProperty(a, r, { value: t }), Object.defineProperty(a, o, { value: n }), e[s].freeze) {
          var _iteratorNormalCompletion89 = true;
          var _didIteratorError89 = false;
          var _iteratorError89 = undefined;

          try {
            for (var _iterator89 = Object.keys(t)[Symbol.iterator](), _step89; !(_iteratorNormalCompletion89 = (_step89 = _iterator89.next()).done); _iteratorNormalCompletion89 = true) {
              var _e91 = _step89.value;
              t[_e91] instanceof y ? t[_e91]._freeze() : t[_e91] instanceof m ? (Object.freeze(t[_e91].elems), Object.freeze(t[_e91])) : (Object.freeze(t[_e91]), Object.freeze(t[_e91][i]));
            }
          } catch (err) {
            _didIteratorError89 = true;
            _iteratorError89 = err;
          } finally {
            try {
              if (!_iteratorNormalCompletion89 && _iterator89.return) {
                _iterator89.return();
              }
            } finally {
              if (_didIteratorError89) {
                throw _iteratorError89;
              }
            }
          }
        }var _iteratorNormalCompletion90 = true;
        var _didIteratorError90 = false;
        var _iteratorError90 = undefined;

        try {
          for (var _iterator90 = Object.keys(e[r])[Symbol.iterator](), _step90; !(_iteratorNormalCompletion90 = (_step90 = _iterator90.next()).done); _iteratorNormalCompletion90 = true) {
            var _n89 = _step90.value;
            t[_n89] || (t[_n89] = e[r][_n89]);
          }
        } catch (err) {
          _didIteratorError90 = true;
          _iteratorError90 = err;
        } finally {
          try {
            if (!_iteratorNormalCompletion90 && _iterator90.return) {
              _iterator90.return();
            }
          } finally {
            if (_didIteratorError90) {
              throw _iteratorError90;
            }
          }
        }

        return e[s].freeze && Object.freeze(t), a;
      }function E(e, t, n) {
        var r = C(e);if (!r) throw new Error("Actor ID must be initialized with setActorId() before making a change");var a = u(e[o]);a.seq += 1;var i = { actor: r, seq: a.seq, startOp: a.maxOp + 1, deps: a.deps, time: n && "number" == typeof n.time ? n.time : Math.round(new Date().getTime() / 1e3), message: n && "string" == typeof n.message ? n.message : "", ops: t.ops };if (e[s].backend) {
          var _e$s$backend$applyLoc = e[s].backend.applyLocalChange(a.backendState, i),
              _e$s$backend$applyLoc2 = _slicedToArray(_e$s$backend$applyLoc, 3),
              _t83 = _e$s$backend$applyLoc2[0],
              _r30 = _e$s$backend$applyLoc2[1],
              _o22 = _e$s$backend$applyLoc2[2];

          a.backendState = _t83, a.lastLocalChange = _o22;var _l5 = O(e, _r30, a, !0),
              _c7 = n && n.patchCallback || e[s].patchCallback;return _c7 && _c7(_r30, e, _l5, !0, [_o22]), [_l5, i];
        }{
          var _n90 = { actor: r, seq: i.seq, before: e };return a.requests = a.requests.concat([_n90]), a.maxOp = a.maxOp + function (e) {
            var t = 0;var _iteratorNormalCompletion91 = true;
            var _didIteratorError91 = false;
            var _iteratorError91 = undefined;

            try {
              for (var _iterator91 = e[Symbol.iterator](), _step91; !(_iteratorNormalCompletion91 = (_step91 = _iterator91.next()).done); _iteratorNormalCompletion91 = true) {
                var _n91 = _step91.value;
                "set" === _n91.action && _n91.values ? t += _n91.values.length : t += 1;
              }
            } catch (err) {
              _didIteratorError91 = true;
              _iteratorError91 = err;
            } finally {
              try {
                if (!_iteratorNormalCompletion91 && _iterator91.return) {
                  _iterator91.return();
                }
              } finally {
                if (_didIteratorError91) {
                  throw _iteratorError91;
                }
              }
            }

            return t;
          }(i.ops), a.deps = [], [j(e, t ? t.updated : {}, a), i];
        }
      }function O(e, t, n, s) {
        var r = C(e),
            o = {};if (f(t.diffs, e, o), s) {
          if (!t.clock) throw new RangeError("patch is missing clock field");t.clock[r] && t.clock[r] > n.seq && (n.seq = t.clock[r]), n.clock = t.clock, n.deps = t.deps, n.maxOp = Math.max(n.maxOp, t.maxOp);
        }return j(e, o, n);
      }function A(e) {
        if ("string" == typeof e) e = { actorId: e };else if (void 0 === e) e = {};else if (!d(e)) throw new TypeError("Unsupported value for init() options: " + e);if (e.deferActorId || (void 0 === e.actorId && (e.actorId = h()), x(e.actorId)), e.observable) {
          var _t84 = e.patchCallback,
              _n92 = e.observable;e.patchCallback = function (e, s, r, o, a) {
            _t84 && _t84(e, s, r, o, a), _n92.patchCallback(e, s, r, o, a);
          };
        }var t = {},
            n = { _root: t },
            l = { seq: 0, maxOp: 0, requests: [], clock: {}, deps: [] };return e.backend && (l.backendState = e.backend.init(), l.lastLocalChange = null), Object.defineProperty(t, a, { value: "_root" }), Object.defineProperty(t, s, { value: Object.freeze(e) }), Object.defineProperty(t, i, { value: Object.freeze({}) }), Object.defineProperty(t, r, { value: Object.freeze(n) }), Object.defineProperty(t, o, { value: Object.freeze(l) }), Object.freeze(t);
      }function R(e, t, n) {
        var _ref17;

        if ("_root" !== e[a]) throw new TypeError("The first argument to Automerge.change must be the document root");if (e[l]) throw new TypeError("Calls to Automerge.change cannot be nested");if ("function" == typeof t && void 0 === n && (_ref17 = [n, t], t = _ref17[0], n = _ref17[1], _ref17), "string" == typeof t && (t = { message: t }), void 0 !== t && !d(t)) throw new TypeError("Unsupported type of options");var s = C(e);if (!s) throw new Error("Actor ID must be initialized with setActorId() before making a change");var r = new g(e, s);return n(b(r)), 0 === Object.keys(r.updated).length ? [e, null] : E(e, r, t);
      }function C(e) {
        return e[o].actorId || e[s].actorId;
      }e.exports = { init: A, from: function from(e, t) {
          return R(A(t), "Initialization", function (t) {
            return Object.assign(t, e);
          });
        }, change: R, emptyChange: function emptyChange(e, t) {
          if ("_root" !== e[a]) throw new TypeError("The first argument to Automerge.emptyChange must be the document root");if ("string" == typeof t && (t = { message: t }), void 0 !== t && !d(t)) throw new TypeError("Unsupported type of options");var n = C(e);if (!n) throw new Error("Actor ID must be initialized with setActorId() before making a change");return E(e, new g(e, n), t);
        }, applyPatch: function applyPatch(e, t, n) {
          if ("_root" !== e[a]) throw new TypeError("The first argument to Frontend.applyPatch must be the document root");var r = u(e[o]);if (e[s].backend) {
            if (!n) throw new RangeError("applyPatch must be called with the updated backend state");return r.backendState = n, O(e, t, r, !0);
          }var i = void 0;if (r.requests.length > 0) {
            if (i = r.requests[0].before, t.actor === C(e)) {
              if (r.requests[0].seq !== t.seq) throw new RangeError("Mismatched sequence number: patch " + t.seq + " does not match next request " + r.requests[0].seq);r.requests = r.requests.slice(1);
            } else r.requests = r.requests.slice();
          } else i = e, r.requests = [];var l = O(i, t, r, !0);return 0 === r.requests.length ? l : (r.requests[0] = u(r.requests[0]), r.requests[0].before = l, j(e, {}, r));
        }, getObjectId: function getObjectId(e) {
          return e[a];
        }, getObjectById: function getObjectById(e, t) {
          if (e[l]) throw new TypeError("Cannot use getObjectById in a change callback");return e[r][t];
        }, getActorId: C, setActorId: function setActorId(e, t) {
          return x(t), j(e, {}, Object.assign({}, e[o], { actorId: t }));
        }, getConflicts: function getConflicts(e, t) {
          if (e[i] && e[i][t] && Object.keys(e[i][t]).length > 1) return e[i][t];
        }, getLastLocalChange: function getLastLocalChange(e) {
          return e[o] && e[o].lastLocalChange ? e[o].lastLocalChange : null;
        }, getBackendState: function getBackendState(e) {
          var t = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : null;
          var n = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : "first";
          if ("_root" !== e[a]) {
            var _s48 = Array.isArray(e) ? ". Note: Automerge.applyChanges now returns an array." : "";throw t ? new TypeError("The " + n + " argument to Automerge." + t + " must be the document root" + _s48) : new TypeError("Argument is not an Automerge document root" + _s48);
          }return e[o].backendState;
        }, getElementIds: function getElementIds(e) {
          return e instanceof m ? e.elems.map(function (e) {
            return e.elemId;
          }) : e[c];
        }, Text: m, Table: y, Counter: w, Observable: k, Float64: _, Int: I, Uint: v };
    }, "./frontend/numbers.js":
    /*!*****************************!*\
      !*** ./frontend/numbers.js ***!
      \*****************************/function frontendNumbersJs(e) {
      e.exports = { Int: function Int(e) {
          _classCallCheck(this, Int);

          if (!(Number.isInteger(e) && e <= Number.MAX_SAFE_INTEGER && e >= Number.MIN_SAFE_INTEGER)) throw new RangeError("Value " + e + " cannot be a uint");this.value = e, Object.freeze(this);
        }, Uint: function Uint(e) {
          _classCallCheck(this, Uint);

          if (!(Number.isInteger(e) && e <= Number.MAX_SAFE_INTEGER && e >= 0)) throw new RangeError("Value " + e + " cannot be a uint");this.value = e, Object.freeze(this);
        }, Float64: function Float64(e) {
          _classCallCheck(this, Float64);

          if ("number" != typeof e) throw new RangeError("Value " + e + " cannot be a float64");this.value = e || 0, Object.freeze(this);
        } };
    }, "./frontend/observable.js":
    /*!********************************!*\
      !*** ./frontend/observable.js ***!
      \********************************/function frontendObservableJs(e, t, n) {
      var _n93 = n( /*! ./constants */"./frontend/constants.js"),
          s = _n93.OBJECT_ID,
          r = _n93.CONFLICTS;

      e.exports = { Observable: function () {
          function Observable() {
            _classCallCheck(this, Observable);

            this.observers = {};
          }

          _createClass(Observable, [{
            key: "patchCallback",
            value: function patchCallback(e, t, n, s, r) {
              this._objectUpdate(e.diffs, t, n, s, r);
            }
          }, {
            key: "_objectUpdate",
            value: function _objectUpdate(e, t, n, s, o) {
              if (e.objectId) {
                if (this.observers[e.objectId]) {
                  var _iteratorNormalCompletion92 = true;
                  var _didIteratorError92 = false;
                  var _iteratorError92 = undefined;

                  try {
                    for (var _iterator92 = this.observers[e.objectId][Symbol.iterator](), _step92; !(_iteratorNormalCompletion92 = (_step92 = _iterator92.next()).done); _iteratorNormalCompletion92 = true) {
                      var _r31 = _step92.value;
                      _r31(e, t, n, s, o);
                    }
                  } catch (err) {
                    _didIteratorError92 = true;
                    _iteratorError92 = err;
                  } finally {
                    try {
                      if (!_iteratorNormalCompletion92 && _iterator92.return) {
                        _iterator92.return();
                      }
                    } finally {
                      if (_didIteratorError92) {
                        throw _iteratorError92;
                      }
                    }
                  }
                }if ("map" === e.type && e.props) {
                  var _iteratorNormalCompletion93 = true;
                  var _didIteratorError93 = false;
                  var _iteratorError93 = undefined;

                  try {
                    for (var _iterator93 = Object.keys(e.props)[Symbol.iterator](), _step93; !(_iteratorNormalCompletion93 = (_step93 = _iterator93.next()).done); _iteratorNormalCompletion93 = true) {
                      var a = _step93.value;
                      var _iteratorNormalCompletion94 = true;
                      var _didIteratorError94 = false;
                      var _iteratorError94 = undefined;

                      try {
                        for (var _iterator94 = Object.keys(e.props[a])[Symbol.iterator](), _step94; !(_iteratorNormalCompletion94 = (_step94 = _iterator94.next()).done); _iteratorNormalCompletion94 = true) {
                          var i = _step94.value;
                          this._objectUpdate(e.props[a][i], t && t[r] && t[r][a] && t[r][a][i], n && n[r] && n[r][a] && n[r][a][i], s, o);
                        }
                      } catch (err) {
                        _didIteratorError94 = true;
                        _iteratorError94 = err;
                      } finally {
                        try {
                          if (!_iteratorNormalCompletion94 && _iterator94.return) {
                            _iterator94.return();
                          }
                        } finally {
                          if (_didIteratorError94) {
                            throw _iteratorError94;
                          }
                        }
                      }
                    }
                  } catch (err) {
                    _didIteratorError93 = true;
                    _iteratorError93 = err;
                  } finally {
                    try {
                      if (!_iteratorNormalCompletion93 && _iterator93.return) {
                        _iterator93.return();
                      }
                    } finally {
                      if (_didIteratorError93) {
                        throw _iteratorError93;
                      }
                    }
                  }
                } else if ("table" === e.type && e.props) {
                  var _iteratorNormalCompletion95 = true;
                  var _didIteratorError95 = false;
                  var _iteratorError95 = undefined;

                  try {
                    for (var _iterator95 = Object.keys(e.props)[Symbol.iterator](), _step95; !(_iteratorNormalCompletion95 = (_step95 = _iterator95.next()).done); _iteratorNormalCompletion95 = true) {
                      var _r32 = _step95.value;
                      var _iteratorNormalCompletion96 = true;
                      var _didIteratorError96 = false;
                      var _iteratorError96 = undefined;

                      try {
                        for (var _iterator96 = Object.keys(e.props[_r32])[Symbol.iterator](), _step96; !(_iteratorNormalCompletion96 = (_step96 = _iterator96.next()).done); _iteratorNormalCompletion96 = true) {
                          var _a19 = _step96.value;
                          this._objectUpdate(e.props[_r32][_a19], t && t.byId(_r32), n && n.byId(_r32), s, o);
                        }
                      } catch (err) {
                        _didIteratorError96 = true;
                        _iteratorError96 = err;
                      } finally {
                        try {
                          if (!_iteratorNormalCompletion96 && _iterator96.return) {
                            _iterator96.return();
                          }
                        } finally {
                          if (_didIteratorError96) {
                            throw _iteratorError96;
                          }
                        }
                      }
                    }
                  } catch (err) {
                    _didIteratorError95 = true;
                    _iteratorError95 = err;
                  } finally {
                    try {
                      if (!_iteratorNormalCompletion95 && _iterator95.return) {
                        _iterator95.return();
                      }
                    } finally {
                      if (_didIteratorError95) {
                        throw _iteratorError95;
                      }
                    }
                  }
                } else if ("list" === e.type && e.edits) {
                  var _a20 = 0;var _iteratorNormalCompletion97 = true;
                  var _didIteratorError97 = false;
                  var _iteratorError97 = undefined;

                  try {
                    for (var _iterator97 = e.edits[Symbol.iterator](), _step97; !(_iteratorNormalCompletion97 = (_step97 = _iterator97.next()).done); _iteratorNormalCompletion97 = true) {
                      var _i14 = _step97.value;
                      "insert" === _i14.action ? (_a20 -= 1, this._objectUpdate(_i14.value, void 0, n && n[r] && n[r][_i14.index] && n[r][_i14.index][_i14.elemId], s, o)) : "multi-insert" === _i14.action ? _a20 -= _i14.values.length : "update" === _i14.action ? this._objectUpdate(_i14.value, t && t[r] && t[r][_i14.index + _a20] && t[r][_i14.index + _a20][_i14.opId], n && n[r] && n[r][_i14.index] && n[r][_i14.index][_i14.opId], s, o) : "remove" === _i14.action && (_a20 += _i14.count);
                    }
                  } catch (err) {
                    _didIteratorError97 = true;
                    _iteratorError97 = err;
                  } finally {
                    try {
                      if (!_iteratorNormalCompletion97 && _iterator97.return) {
                        _iterator97.return();
                      }
                    } finally {
                      if (_didIteratorError97) {
                        throw _iteratorError97;
                      }
                    }
                  }
                } else if ("text" === e.type && e.edits) {
                  var _r33 = 0;var _iteratorNormalCompletion98 = true;
                  var _didIteratorError98 = false;
                  var _iteratorError98 = undefined;

                  try {
                    for (var _iterator98 = e.edits[Symbol.iterator](), _step98; !(_iteratorNormalCompletion98 = (_step98 = _iterator98.next()).done); _iteratorNormalCompletion98 = true) {
                      var _a21 = _step98.value;
                      "insert" === _a21.action ? (_r33 -= 1, this._objectUpdate(_a21.value, void 0, n && n.get(_a21.index), s, o)) : "multi-insert" === _a21.action ? _r33 -= _a21.values.length : "update" === _a21.action ? this._objectUpdate(_a21.value, t && t.get(_a21.index + _r33), n && n.get(_a21.index), s, o) : "remove" === _a21.action && (_r33 += _a21.count);
                    }
                  } catch (err) {
                    _didIteratorError98 = true;
                    _iteratorError98 = err;
                  } finally {
                    try {
                      if (!_iteratorNormalCompletion98 && _iterator98.return) {
                        _iterator98.return();
                      }
                    } finally {
                      if (_didIteratorError98) {
                        throw _iteratorError98;
                      }
                    }
                  }
                }
              }
            }
          }, {
            key: "observe",
            value: function observe(e, t) {
              var n = e[s];if (!n) throw new TypeError("The observed object must be part of an Automerge document");this.observers[n] || (this.observers[n] = []), this.observers[n].push(t);
            }
          }]);

          return Observable;
        }() };
    }, "./frontend/proxies.js":
    /*!*****************************!*\
      !*** ./frontend/proxies.js ***!
      \*****************************/function frontendProxiesJs(e, t, n) {
      var _n94 = n( /*! ./constants */"./frontend/constants.js"),
          s = _n94.OBJECT_ID,
          r = _n94.CHANGE,
          o = _n94.STATE,
          _n95 = n( /*! ../src/common */"./src/common.js"),
          a = _n95.createArrayOfNulls,
          _n96 = n( /*! ./text */"./frontend/text.js"),
          i = _n96.Text,
          _n97 = n( /*! ./table */"./frontend/table.js"),
          l = _n97.Table;

      function c(e) {
        if ("string" == typeof e && /^[0-9]+$/.test(e) && (e = parseInt(e, 10)), "number" != typeof e) throw new TypeError("A list index must be a number, but you passed " + JSON.stringify(e));if (e < 0 || isNaN(e) || e === 1 / 0 || e === -1 / 0) throw new RangeError("A list index must be positive, but you passed " + e);return e;
      }var d = {
        get: function get(e, t) {
          var n = e.context,
              a = e.objectId,
              i = e.path;
          return t === s ? a : t === r ? n : t === o ? { actorId: n.actorId } : n.getObjectField(i, a, t);
        },
        set: function set(e, t, n) {
          var s = e.context,
              r = e.path,
              o = e.readonly;
          if (Array.isArray(o) && o.indexOf(t) >= 0) throw new RangeError("Object property \"" + t + "\" cannot be modified");return s.setMapKey(r, t, n), !0;
        },
        deleteProperty: function deleteProperty(e, t) {
          var n = e.context,
              s = e.path,
              r = e.readonly;
          if (Array.isArray(r) && r.indexOf(t) >= 0) throw new RangeError("Object property \"" + t + "\" cannot be modified");return n.deleteMapKey(s, t), !0;
        },
        has: function has(e, t) {
          var n = e.context,
              o = e.objectId;
          return [s, r].includes(t) || t in n.getObject(o);
        },
        getOwnPropertyDescriptor: function getOwnPropertyDescriptor(e, t) {
          var n = e.context,
              s = e.objectId;
          if (t in n.getObject(s)) return { configurable: !0, enumerable: !0, value: n.getObjectField(s, t) };
        },
        ownKeys: function ownKeys(e) {
          var t = e.context,
              n = e.objectId;
          return Object.keys(t.getObject(n));
        }
      },
          u = {
        get: function get(e, t) {
          var _e92 = _slicedToArray(e, 3),
              n = _e92[0],
              o = _e92[1],
              a = _e92[2];

          return t === Symbol.iterator ? n.getObject(o)[Symbol.iterator] : t === s ? o : t === r ? n : "length" === t ? n.getObject(o).length : "string" == typeof t && /^[0-9]+$/.test(t) ? n.getObjectField(a, o, c(t)) : function (e, t, n) {
            var r = {
              deleteAt: function deleteAt(t, s) {
                return e.splice(n, c(t), s || 1, []), this;
              },
              fill: function fill(s, r, o) {
                var a = e.getObject(t);for (var _t85 = c(r || 0); _t85 < c(o || a.length); _t85++) {
                  e.setListIndex(n, _t85, s);
                }return this;
              },
              indexOf: function indexOf(n) {
                var r = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : 0;
                var o = n[s];if (o) {
                  var _n98 = e.getObject(t);for (var _e93 = r; _e93 < _n98.length; _e93++) {
                    if (_n98[_e93][s] === o) return _e93;
                  }return -1;
                }return e.getObject(t).indexOf(n, r);
              },
              insertAt: function insertAt(t) {
                for (var _len = arguments.length, s = Array(_len > 1 ? _len - 1 : 0), _key = 1; _key < _len; _key++) {
                  s[_key - 1] = arguments[_key];
                }

                return e.splice(n, c(t), 0, s), this;
              },
              pop: function pop() {
                var s = e.getObject(t);if (0 == s.length) return;var r = e.getObjectField(n, t, s.length - 1);return e.splice(n, s.length - 1, 1, []), r;
              },
              push: function push() {
                var r = e.getObject(t);
                for (var _len2 = arguments.length, s = Array(_len2), _key2 = 0; _key2 < _len2; _key2++) {
                  s[_key2] = arguments[_key2];
                }

                return e.splice(n, r.length, 0, s), e.getObject(t).length;
              },
              shift: function shift() {
                if (0 == e.getObject(t).length) return;var s = e.getObjectField(n, t, 0);return e.splice(n, 0, 1, []), s;
              },
              splice: function splice(s, r) {
                var a = e.getObject(t);s = c(s), (void 0 === r || r > a.length - s) && (r = a.length - s);var i = [];for (var _o23 = 0; _o23 < r; _o23++) {
                  i.push(e.getObjectField(n, t, s + _o23));
                }
                for (var _len3 = arguments.length, o = Array(_len3 > 2 ? _len3 - 2 : 0), _key3 = 2; _key3 < _len3; _key3++) {
                  o[_key3 - 2] = arguments[_key3];
                }

                return e.splice(n, s, r, o), i;
              },
              unshift: function unshift() {
                for (var _len4 = arguments.length, s = Array(_len4), _key4 = 0; _key4 < _len4; _key4++) {
                  s[_key4] = arguments[_key4];
                }

                return e.splice(n, 0, 0, s), e.getObject(t).length;
              } };
            var _loop3 = function _loop3(_n99) {
              var s = e.getObject(t);r[_n99] = function () {
                return s[_n99]();
              };
            };

            var _arr = ["entries", "keys", "values"];
            for (var _i15 = 0; _i15 < _arr.length; _i15++) {
              var _n99 = _arr[_i15];
              _loop3(_n99);
            }
            var _loop4 = function _loop4(_s49) {
              r[_s49] = function () {
                var _e$getObject$map;

                for (var _len5 = arguments.length, r = Array(_len5), _key5 = 0; _key5 < _len5; _key5++) {
                  r[_key5] = arguments[_key5];
                }

                return (_e$getObject$map = e.getObject(t).map(function (s, r) {
                  return e.getObjectField(n, t, r);
                }))[_s49].apply(_e$getObject$map, r);
              };
            };

            var _arr2 = ["concat", "every", "filter", "find", "findIndex", "forEach", "includes", "join", "lastIndexOf", "map", "reduce", "reduceRight", "slice", "some", "toLocaleString", "toString"];
            for (var _i16 = 0; _i16 < _arr2.length; _i16++) {
              var _s49 = _arr2[_i16];
              _loop4(_s49);
            }return r;
          }(n, o, a)[t];
        },
        set: function set(e, t, n) {
          var _e94 = _slicedToArray(e, 3),
              s = _e94[0],
              r = _e94[1],
              o = _e94[2];

          if ("length" === t) {
            if ("number" != typeof n) throw new RangeError("Invalid array length");var _e95 = s.getObject(r).length;_e95 > n ? s.splice(o, n, _e95 - n, []) : s.splice(o, _e95, 0, a(n - _e95));
          } else s.setListIndex(o, c(t), n);return !0;
        },
        deleteProperty: function deleteProperty(e, t) {
          var _e96 = _slicedToArray(e, 3),
              n = _e96[0],
              s = _e96[2];

          return n.splice(s, c(t), 1, []), !0;
        },
        has: function has(e, t) {
          var _e97 = _slicedToArray(e, 2),
              n = _e97[0],
              o = _e97[1];

          return "string" == typeof t && /^[0-9]+$/.test(t) ? c(t) < n.getObject(o).length : ["length", s, r].includes(t);
        },
        getOwnPropertyDescriptor: function getOwnPropertyDescriptor(e, t) {
          var _e98 = _slicedToArray(e, 2),
              n = _e98[0],
              r = _e98[1],
              o = n.getObject(r);

          if ("length" === t) return { writable: !0, value: o.length };if (t === s) return { configurable: !1, enumerable: !1, value: r };if ("string" == typeof t && /^[0-9]+$/.test(t)) {
            var _e99 = c(t);if (_e99 < o.length) return { configurable: !0, enumerable: !0, value: n.getObjectField(r, _e99) };
          }
        },
        ownKeys: function ownKeys(e) {
          var _e100 = _slicedToArray(e, 2),
              t = _e100[0],
              n = _e100[1],
              s = t.getObject(n);

          var r = ["length"];var _iteratorNormalCompletion99 = true;
          var _didIteratorError99 = false;
          var _iteratorError99 = undefined;

          try {
            for (var _iterator99 = Object.keys(s)[Symbol.iterator](), _step99; !(_iteratorNormalCompletion99 = (_step99 = _iterator99.next()).done); _iteratorNormalCompletion99 = true) {
              var _e101 = _step99.value;
              r.push(_e101);
            }
          } catch (err) {
            _didIteratorError99 = true;
            _iteratorError99 = err;
          } finally {
            try {
              if (!_iteratorNormalCompletion99 && _iterator99.return) {
                _iterator99.return();
              }
            } finally {
              if (_didIteratorError99) {
                throw _iteratorError99;
              }
            }
          }

          return r;
        }
      };function h(e, t, n, s) {
        return new Proxy({ context: e, objectId: t, path: n, readonly: s }, d);
      }function f(e, t, n) {
        var s = this.getObject(t);return Array.isArray(s) ? function (e, t, n) {
          return new Proxy([e, t, n], u);
        }(this, t, e) : s instanceof i || s instanceof l ? s.getWriteable(this, e) : h(this, t, e, n);
      }e.exports = { rootObjectProxy: function rootObjectProxy(e) {
          return e.instantiateObject = f, h(e, "_root", []);
        } };
    }, "./frontend/table.js":
    /*!***************************!*\
      !*** ./frontend/table.js ***!
      \***************************/function frontendTableJs(e, t, n) {
      var _n100 = n( /*! ./constants */"./frontend/constants.js"),
          s = _n100.OBJECT_ID,
          r = _n100.CONFLICTS,
          _n101 = n( /*! ../src/common */"./src/common.js"),
          o = _n101.isObject,
          a = _n101.copyObject;

      function i(e, t, n) {
        var _iteratorNormalCompletion100 = true;
        var _didIteratorError100 = false;
        var _iteratorError100 = undefined;

        try {
          for (var _iterator100 = e[Symbol.iterator](), _step100; !(_iteratorNormalCompletion100 = (_step100 = _iterator100.next()).done); _iteratorNormalCompletion100 = true) {
            var _s50 = _step100.value;
            if (t[_s50] !== n[_s50]) {
              if ("number" == typeof t[_s50] && "number" == typeof n[_s50]) return t[_s50] - n[_s50];{
                var _e102 = "" + t[_s50],
                    _r34 = "" + n[_s50];if (_e102 === _r34) continue;return _e102 < _r34 ? -1 : 1;
              }
            }
          }
        } catch (err) {
          _didIteratorError100 = true;
          _iteratorError100 = err;
        } finally {
          try {
            if (!_iteratorNormalCompletion100 && _iterator100.return) {
              _iterator100.return();
            }
          } finally {
            if (_didIteratorError100) {
              throw _iteratorError100;
            }
          }
        }

        return 0;
      }
      var l = function () {
        function l() {
          _classCallCheck(this, l);

          this.entries = Object.freeze({}), this.opIds = Object.freeze({}), Object.freeze(this);
        }

        _createClass(l, [{
          key: "byId",
          value: function byId(e) {
            return this.entries[e];
          }
        }, {
          key: "filter",
          value: function filter(e, t) {
            return this.rows.filter(e, t);
          }
        }, {
          key: "find",
          value: function find(e, t) {
            return this.rows.find(e, t);
          }
        }, {
          key: "map",
          value: function map(e, t) {
            return this.rows.map(e, t);
          }
        }, {
          key: "sort",
          value: function sort(e) {
            if ("function" == typeof e) return this.rows.sort(e);if ("string" == typeof e) return this.rows.sort(function (t, n) {
              return i([e], t, n);
            });if (Array.isArray(e)) return this.rows.sort(function (t, n) {
              return i(e, t, n);
            });if (void 0 === e) return this.rows.sort(function (e, t) {
              return i(["id"], e, t);
            });throw new TypeError("Unsupported sorting argument: " + e);
          }
        }, {
          key: Symbol.iterator,
          value: function value() {
            var e = this.rows,
                t = -1;return { next: function next() {
                return t += 1, t < e.length ? { done: !1, value: e[t] } : { done: !0 };
              } };
          }
        }, {
          key: "_clone",
          value: function _clone() {
            if (!this[s]) throw new RangeError("clone() requires the objectId to be set");return d(this[s], a(this.entries), a(this.opIds));
          }
        }, {
          key: "_set",
          value: function _set(e, t, n) {
            if (Object.isFrozen(this.entries)) throw new Error("A table can only be modified in a change function");o(t) && !Array.isArray(t) && Object.defineProperty(t, "id", { value: e, enumerable: !0 }), this.entries[e] = t, this.opIds[e] = n;
          }
        }, {
          key: "remove",
          value: function remove(e) {
            if (Object.isFrozen(this.entries)) throw new Error("A table can only be modified in a change function");delete this.entries[e], delete this.opIds[e];
          }
        }, {
          key: "_freeze",
          value: function _freeze() {
            Object.freeze(this.entries), Object.freeze(this.opIds), Object.freeze(this);
          }
        }, {
          key: "getWriteable",
          value: function getWriteable(e, t) {
            if (!this[s]) throw new RangeError("getWriteable() requires the objectId to be set");var n = Object.create(c.prototype);return n[s] = this[s], n.context = e, n.entries = this.entries, n.opIds = this.opIds, n.path = t, n;
          }
        }, {
          key: "toJSON",
          value: function toJSON() {
            var e = {};var _iteratorNormalCompletion101 = true;
            var _didIteratorError101 = false;
            var _iteratorError101 = undefined;

            try {
              for (var _iterator101 = this.ids[Symbol.iterator](), _step101; !(_iteratorNormalCompletion101 = (_step101 = _iterator101.next()).done); _iteratorNormalCompletion101 = true) {
                var _t86 = _step101.value;
                e[_t86] = this.byId(_t86);
              }
            } catch (err) {
              _didIteratorError101 = true;
              _iteratorError101 = err;
            } finally {
              try {
                if (!_iteratorNormalCompletion101 && _iterator101.return) {
                  _iterator101.return();
                }
              } finally {
                if (_didIteratorError101) {
                  throw _iteratorError101;
                }
              }
            }

            return e;
          }
        }, {
          key: "ids",
          get: function get() {
            var _this14 = this;

            return Object.keys(this.entries).filter(function (e) {
              var t = _this14.entries[e];return o(t) && t.id === e;
            });
          }
        }, {
          key: "count",
          get: function get() {
            return this.ids.length;
          }
        }, {
          key: "rows",
          get: function get() {
            var _this15 = this;

            return this.ids.map(function (e) {
              return _this15.byId(e);
            });
          }
        }]);

        return l;
      }();

      var c = function (_l6) {
        _inherits(c, _l6);

        function c() {
          _classCallCheck(this, c);

          return _possibleConstructorReturn(this, (c.__proto__ || Object.getPrototypeOf(c)).apply(this, arguments));
        }

        _createClass(c, [{
          key: "byId",
          value: function byId(e) {
            if (o(this.entries[e]) && this.entries[e].id === e) {
              var _t87 = this.entries[e][s],
                  _n102 = this.path.concat([{ key: e, objectId: _t87 }]);return this.context.instantiateObject(_n102, _t87, ["id"]);
            }
          }
        }, {
          key: "add",
          value: function add(e) {
            return this.context.addTableRow(this.path, e);
          }
        }, {
          key: "remove",
          value: function remove(e) {
            if (!o(this.entries[e]) || this.entries[e].id !== e) throw new RangeError("There is no row with ID " + e + " in this table");this.context.deleteTableRow(this.path, e, this.opIds[e]);
          }
        }]);

        return c;
      }(l);

      function d(e, t, n) {
        var o = Object.create(l.prototype);if (!e) throw new RangeError("instantiateTable requires an objectId to be given");return o[s] = e, o[r] = Object.freeze({}), o.entries = t || {}, o.opIds = n || {}, o;
      }e.exports = { Table: l, instantiateTable: d };
    }, "./frontend/text.js":
    /*!**************************!*\
      !*** ./frontend/text.js ***!
      \**************************/function frontendTextJs(e, t, n) {
      var _n103 = n( /*! ./constants */"./frontend/constants.js"),
          s = _n103.OBJECT_ID,
          _n104 = n( /*! ../src/common */"./src/common.js"),
          r = _n104.isObject;

      var o = function () {
        function o(e) {
          _classCallCheck(this, o);

          if ("string" == typeof e) return a(void 0, [].concat(_toConsumableArray(e)).map(function (e) {
            return { value: e };
          }));if (Array.isArray(e)) return a(void 0, e.map(function (e) {
            return { value: e };
          }));if (void 0 === e) return a(void 0, []);throw new TypeError("Unsupported initial value for Text: " + e);
        }

        _createClass(o, [{
          key: "get",
          value: function get(e) {
            var t = this.elems[e].value;if (this.context && r(t)) {
              var _n105 = t[s],
                  _r35 = this.path.concat([{ key: e, objectId: _n105 }]);return this.context.instantiateObject(_r35, _n105);
            }return t;
          }
        }, {
          key: "getElemId",
          value: function getElemId(e) {
            return this.elems[e].elemId;
          }
        }, {
          key: Symbol.iterator,
          value: function value() {
            var e = this.elems,
                t = -1;return { next: function next() {
                return t += 1, t < e.length ? { done: !1, value: e[t].value } : { done: !0 };
              } };
          }
        }, {
          key: "toString",
          value: function toString() {
            var e = "";var _iteratorNormalCompletion102 = true;
            var _didIteratorError102 = false;
            var _iteratorError102 = undefined;

            try {
              for (var _iterator102 = this.elems[Symbol.iterator](), _step102; !(_iteratorNormalCompletion102 = (_step102 = _iterator102.next()).done); _iteratorNormalCompletion102 = true) {
                var _t88 = _step102.value;
                "string" == typeof _t88.value && (e += _t88.value);
              }
            } catch (err) {
              _didIteratorError102 = true;
              _iteratorError102 = err;
            } finally {
              try {
                if (!_iteratorNormalCompletion102 && _iterator102.return) {
                  _iterator102.return();
                }
              } finally {
                if (_didIteratorError102) {
                  throw _iteratorError102;
                }
              }
            }

            return e;
          }
        }, {
          key: "toSpans",
          value: function toSpans() {
            var e = [],
                t = "";var _iteratorNormalCompletion103 = true;
            var _didIteratorError103 = false;
            var _iteratorError103 = undefined;

            try {
              for (var _iterator103 = this.elems[Symbol.iterator](), _step103; !(_iteratorNormalCompletion103 = (_step103 = _iterator103.next()).done); _iteratorNormalCompletion103 = true) {
                var _n106 = _step103.value;
                "string" == typeof _n106.value ? t += _n106.value : (t.length > 0 && (e.push(t), t = ""), e.push(_n106.value));
              }
            } catch (err) {
              _didIteratorError103 = true;
              _iteratorError103 = err;
            } finally {
              try {
                if (!_iteratorNormalCompletion103 && _iterator103.return) {
                  _iterator103.return();
                }
              } finally {
                if (_didIteratorError103) {
                  throw _iteratorError103;
                }
              }
            }

            return t.length > 0 && e.push(t), e;
          }
        }, {
          key: "toJSON",
          value: function toJSON() {
            return this.toString();
          }
        }, {
          key: "getWriteable",
          value: function getWriteable(e, t) {
            if (!this[s]) throw new RangeError("getWriteable() requires the objectId to be set");var n = a(this[s], this.elems);return n.context = e, n.path = t, n;
          }
        }, {
          key: "set",
          value: function set(e, t) {
            if (this.context) this.context.setListIndex(this.path, e, t);else {
              if (this[s]) throw new TypeError("Automerge.Text object cannot be modified outside of a change block");this.elems[e].value = t;
            }return this;
          }
        }, {
          key: "insertAt",
          value: function insertAt(e) {
            for (var _len6 = arguments.length, t = Array(_len6 > 1 ? _len6 - 1 : 0), _key6 = 1; _key6 < _len6; _key6++) {
              t[_key6 - 1] = arguments[_key6];
            }

            if (this.context) this.context.splice(this.path, e, 0, t);else {
              var _elems;

              if (this[s]) throw new TypeError("Automerge.Text object cannot be modified outside of a change block");(_elems = this.elems).splice.apply(_elems, [e, 0].concat(_toConsumableArray(t.map(function (e) {
                return { value: e };
              }))));
            }return this;
          }
        }, {
          key: "deleteAt",
          value: function deleteAt(e) {
            var t = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : 1;
            if (this.context) this.context.splice(this.path, e, t, []);else {
              if (this[s]) throw new TypeError("Automerge.Text object cannot be modified outside of a change block");this.elems.splice(e, t);
            }return this;
          }
        }, {
          key: "length",
          get: function get() {
            return this.elems.length;
          }
        }]);

        return o;
      }();

      var _loop5 = function _loop5(_e103) {
        o.prototype[_e103] = function () {
          var _ref18;

          return (_ref18 = [].concat(_toConsumableArray(this)))[_e103].apply(_ref18, arguments);
        };
      };

      var _arr3 = ["concat", "every", "filter", "find", "findIndex", "forEach", "includes", "indexOf", "join", "lastIndexOf", "map", "reduce", "reduceRight", "slice", "some", "toLocaleString"];
      for (var _i17 = 0; _i17 < _arr3.length; _i17++) {
        var _e103 = _arr3[_i17];
        _loop5(_e103);
      }function a(e, t) {
        var n = Object.create(o.prototype);return n[s] = e, n.elems = t, n;
      }e.exports = { Text: o, instantiateText: a };
    }, "./node_modules/fast-sha256/sha256.js":
    /*!********************************************!*\
      !*** ./node_modules/fast-sha256/sha256.js ***!
      \********************************************/function node_modulesFastSha256Sha256Js(e, t, n) {
      var s;!function (t, r) {
        var o = {};!function (e) {
          "use strict";
          e.__esModule = !0, e.digestLength = 32, e.blockSize = 64;var t = new Uint32Array([1116352408, 1899447441, 3049323471, 3921009573, 961987163, 1508970993, 2453635748, 2870763221, 3624381080, 310598401, 607225278, 1426881987, 1925078388, 2162078206, 2614888103, 3248222580, 3835390401, 4022224774, 264347078, 604807628, 770255983, 1249150122, 1555081692, 1996064986, 2554220882, 2821834349, 2952996808, 3210313671, 3336571891, 3584528711, 113926993, 338241895, 666307205, 773529912, 1294757372, 1396182291, 1695183700, 1986661051, 2177026350, 2456956037, 2730485921, 2820302411, 3259730800, 3345764771, 3516065817, 3600352804, 4094571909, 275423344, 430227734, 506948616, 659060556, 883997877, 958139571, 1322822218, 1537002063, 1747873779, 1955562222, 2024104815, 2227730452, 2361852424, 2428436474, 2756734187, 3204031479, 3329325298]);function n(e, n, s, r, o) {
            for (var a, i, l, c, d, u, h, f, p, b, g, m, y; o >= 64;) {
              for (a = n[0], i = n[1], l = n[2], c = n[3], d = n[4], u = n[5], h = n[6], f = n[7], b = 0; b < 16; b++) {
                g = r + 4 * b, e[b] = (255 & s[g]) << 24 | (255 & s[g + 1]) << 16 | (255 & s[g + 2]) << 8 | 255 & s[g + 3];
              }for (b = 16; b < 64; b++) {
                m = ((p = e[b - 2]) >>> 17 | p << 15) ^ (p >>> 19 | p << 13) ^ p >>> 10, y = ((p = e[b - 15]) >>> 7 | p << 25) ^ (p >>> 18 | p << 14) ^ p >>> 3, e[b] = (m + e[b - 7] | 0) + (y + e[b - 16] | 0);
              }for (b = 0; b < 64; b++) {
                m = (((d >>> 6 | d << 26) ^ (d >>> 11 | d << 21) ^ (d >>> 25 | d << 7)) + (d & u ^ ~d & h) | 0) + (f + (t[b] + e[b] | 0) | 0) | 0, y = ((a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10)) + (a & i ^ a & l ^ i & l) | 0, f = h, h = u, u = d, d = c + m | 0, c = l, l = i, i = a, a = m + y | 0;
              }n[0] += a, n[1] += i, n[2] += l, n[3] += c, n[4] += d, n[5] += u, n[6] += h, n[7] += f, r += 64, o -= 64;
            }return r;
          }var s = function () {
            function t() {
              this.digestLength = e.digestLength, this.blockSize = e.blockSize, this.state = new Int32Array(8), this.temp = new Int32Array(64), this.buffer = new Uint8Array(128), this.bufferLength = 0, this.bytesHashed = 0, this.finished = !1, this.reset();
            }return t.prototype.reset = function () {
              return this.state[0] = 1779033703, this.state[1] = 3144134277, this.state[2] = 1013904242, this.state[3] = 2773480762, this.state[4] = 1359893119, this.state[5] = 2600822924, this.state[6] = 528734635, this.state[7] = 1541459225, this.bufferLength = 0, this.bytesHashed = 0, this.finished = !1, this;
            }, t.prototype.clean = function () {
              for (var e = 0; e < this.buffer.length; e++) {
                this.buffer[e] = 0;
              }for (e = 0; e < this.temp.length; e++) {
                this.temp[e] = 0;
              }this.reset();
            }, t.prototype.update = function (e, t) {
              if (void 0 === t && (t = e.length), this.finished) throw new Error("SHA256: can't update because hash was finished.");var s = 0;if (this.bytesHashed += t, this.bufferLength > 0) {
                for (; this.bufferLength < 64 && t > 0;) {
                  this.buffer[this.bufferLength++] = e[s++], t--;
                }64 === this.bufferLength && (n(this.temp, this.state, this.buffer, 0, 64), this.bufferLength = 0);
              }for (t >= 64 && (s = n(this.temp, this.state, e, s, t), t %= 64); t > 0;) {
                this.buffer[this.bufferLength++] = e[s++], t--;
              }return this;
            }, t.prototype.finish = function (e) {
              if (!this.finished) {
                var t = this.bytesHashed,
                    s = this.bufferLength,
                    r = t / 536870912 | 0,
                    o = t << 3,
                    a = t % 64 < 56 ? 64 : 128;this.buffer[s] = 128;for (var i = s + 1; i < a - 8; i++) {
                  this.buffer[i] = 0;
                }this.buffer[a - 8] = r >>> 24 & 255, this.buffer[a - 7] = r >>> 16 & 255, this.buffer[a - 6] = r >>> 8 & 255, this.buffer[a - 5] = r >>> 0 & 255, this.buffer[a - 4] = o >>> 24 & 255, this.buffer[a - 3] = o >>> 16 & 255, this.buffer[a - 2] = o >>> 8 & 255, this.buffer[a - 1] = o >>> 0 & 255, n(this.temp, this.state, this.buffer, 0, a), this.finished = !0;
              }for (i = 0; i < 8; i++) {
                e[4 * i + 0] = this.state[i] >>> 24 & 255, e[4 * i + 1] = this.state[i] >>> 16 & 255, e[4 * i + 2] = this.state[i] >>> 8 & 255, e[4 * i + 3] = this.state[i] >>> 0 & 255;
              }return this;
            }, t.prototype.digest = function () {
              var e = new Uint8Array(this.digestLength);return this.finish(e), e;
            }, t.prototype._saveState = function (e) {
              for (var t = 0; t < this.state.length; t++) {
                e[t] = this.state[t];
              }
            }, t.prototype._restoreState = function (e, t) {
              for (var n = 0; n < this.state.length; n++) {
                this.state[n] = e[n];
              }this.bytesHashed = t, this.finished = !1, this.bufferLength = 0;
            }, t;
          }();e.Hash = s;var r = function () {
            function e(e) {
              this.inner = new s(), this.outer = new s(), this.blockSize = this.inner.blockSize, this.digestLength = this.inner.digestLength;var t = new Uint8Array(this.blockSize);if (e.length > this.blockSize) new s().update(e).finish(t).clean();else for (var n = 0; n < e.length; n++) {
                t[n] = e[n];
              }for (n = 0; n < t.length; n++) {
                t[n] ^= 54;
              }for (this.inner.update(t), n = 0; n < t.length; n++) {
                t[n] ^= 106;
              }for (this.outer.update(t), this.istate = new Uint32Array(8), this.ostate = new Uint32Array(8), this.inner._saveState(this.istate), this.outer._saveState(this.ostate), n = 0; n < t.length; n++) {
                t[n] = 0;
              }
            }return e.prototype.reset = function () {
              return this.inner._restoreState(this.istate, this.inner.blockSize), this.outer._restoreState(this.ostate, this.outer.blockSize), this;
            }, e.prototype.clean = function () {
              for (var e = 0; e < this.istate.length; e++) {
                this.ostate[e] = this.istate[e] = 0;
              }this.inner.clean(), this.outer.clean();
            }, e.prototype.update = function (e) {
              return this.inner.update(e), this;
            }, e.prototype.finish = function (e) {
              return this.outer.finished ? this.outer.finish(e) : (this.inner.finish(e), this.outer.update(e, this.digestLength).finish(e)), this;
            }, e.prototype.digest = function () {
              var e = new Uint8Array(this.digestLength);return this.finish(e), e;
            }, e;
          }();function o(e) {
            var t = new s().update(e),
                n = t.digest();return t.clean(), n;
          }function a(e, t) {
            var n = new r(e).update(t),
                s = n.digest();return n.clean(), s;
          }function i(e, t, n, s) {
            var r = s[0];if (0 === r) throw new Error("hkdf: cannot expand more");t.reset(), r > 1 && t.update(e), n && t.update(n), t.update(s), t.finish(e), s[0]++;
          }e.HMAC = r, e.hash = o, e.default = o, e.hmac = a;var l = new Uint8Array(e.digestLength);function c(e, t, n, s) {
            void 0 === t && (t = l), void 0 === s && (s = 32);for (var o = new Uint8Array([1]), c = a(t, e), d = new r(c), u = new Uint8Array(d.digestLength), h = u.length, f = new Uint8Array(s), p = 0; p < s; p++) {
              h === u.length && (i(u, d, n, o), h = 0), f[p] = u[h++];
            }return d.clean(), u.fill(0), o.fill(0), f;
          }function d(e, t, n, s) {
            for (var o = new r(e), a = o.digestLength, i = new Uint8Array(4), l = new Uint8Array(a), c = new Uint8Array(a), d = new Uint8Array(s), u = 0; u * a < s; u++) {
              var h = u + 1;i[0] = h >>> 24 & 255, i[1] = h >>> 16 & 255, i[2] = h >>> 8 & 255, i[3] = h >>> 0 & 255, o.reset(), o.update(t), o.update(i), o.finish(c);for (var f = 0; f < a; f++) {
                l[f] = c[f];
              }for (f = 2; f <= n; f++) {
                o.reset(), o.update(c).finish(c);for (var p = 0; p < a; p++) {
                  l[p] ^= c[p];
                }
              }for (f = 0; f < a && u * a + f < s; f++) {
                d[u * a + f] = l[f];
              }
            }for (u = 0; u < a; u++) {
              l[u] = c[u] = 0;
            }for (u = 0; u < 4; u++) {
              i[u] = 0;
            }return o.clean(), d;
          }e.hkdf = c, e.pbkdf2 = d;
        }(o);var a = o.default;for (var i in o) {
          a[i] = o[i];
        }"object" == _typeof(e.exports) ? e.exports = a : void 0 === (s = function () {
          return a;
        }.call(o, n, o, e)) || (e.exports = s);
      }();
    }, "./node_modules/pako/index.js":
    /*!************************************!*\
      !*** ./node_modules/pako/index.js ***!
      \************************************/function node_modulesPakoIndexJs(e, t, n) {
      "use strict";

      var _n107 = n( /*! ./lib/deflate */"./node_modules/pako/lib/deflate.js"),
          s = _n107.Deflate,
          r = _n107.deflate,
          o = _n107.deflateRaw,
          a = _n107.gzip,
          _n108 = n( /*! ./lib/inflate */"./node_modules/pako/lib/inflate.js"),
          i = _n108.Inflate,
          l = _n108.inflate,
          c = _n108.inflateRaw,
          d = _n108.ungzip,
          u = n( /*! ./lib/zlib/constants */"./node_modules/pako/lib/zlib/constants.js");

      e.exports.Deflate = s, e.exports.deflate = r, e.exports.deflateRaw = o, e.exports.gzip = a, e.exports.Inflate = i, e.exports.inflate = l, e.exports.inflateRaw = c, e.exports.ungzip = d, e.exports.constants = u;
    }, "./node_modules/pako/lib/deflate.js":
    /*!******************************************!*\
      !*** ./node_modules/pako/lib/deflate.js ***!
      \******************************************/function node_modulesPakoLibDeflateJs(e, t, n) {
      "use strict";
      var s = n( /*! ./zlib/deflate */"./node_modules/pako/lib/zlib/deflate.js"),
          r = n( /*! ./utils/common */"./node_modules/pako/lib/utils/common.js"),
          o = n( /*! ./utils/strings */"./node_modules/pako/lib/utils/strings.js"),
          a = n( /*! ./zlib/messages */"./node_modules/pako/lib/zlib/messages.js"),
          i = n( /*! ./zlib/zstream */"./node_modules/pako/lib/zlib/zstream.js"),
          l = Object.prototype.toString,
          _n109 = n( /*! ./zlib/constants */"./node_modules/pako/lib/zlib/constants.js"),
          c = _n109.Z_NO_FLUSH,
          d = _n109.Z_SYNC_FLUSH,
          u = _n109.Z_FULL_FLUSH,
          h = _n109.Z_FINISH,
          f = _n109.Z_OK,
          p = _n109.Z_STREAM_END,
          b = _n109.Z_DEFAULT_COMPRESSION,
          g = _n109.Z_DEFAULT_STRATEGY,
          m = _n109.Z_DEFLATED;function y(e) {
        this.options = r.assign({ level: b, method: m, chunkSize: 16384, windowBits: 15, memLevel: 8, strategy: g }, e || {});var t = this.options;t.raw && t.windowBits > 0 ? t.windowBits = -t.windowBits : t.gzip && t.windowBits > 0 && t.windowBits < 16 && (t.windowBits += 16), this.err = 0, this.msg = "", this.ended = !1, this.chunks = [], this.strm = new i(), this.strm.avail_out = 0;var n = s.deflateInit2(this.strm, t.level, t.method, t.windowBits, t.memLevel, t.strategy);if (n !== f) throw new Error(a[n]);if (t.header && s.deflateSetHeader(this.strm, t.header), t.dictionary) {
          var _e104 = void 0;if (_e104 = "string" == typeof t.dictionary ? o.string2buf(t.dictionary) : "[object ArrayBuffer]" === l.call(t.dictionary) ? new Uint8Array(t.dictionary) : t.dictionary, n = s.deflateSetDictionary(this.strm, _e104), n !== f) throw new Error(a[n]);this._dict_set = !0;
        }
      }function w(e, t) {
        var n = new y(t);if (n.push(e, !0), n.err) throw n.msg || a[n.err];return n.result;
      }y.prototype.push = function (e, t) {
        var n = this.strm,
            r = this.options.chunkSize;var a = void 0,
            i = void 0;if (this.ended) return !1;for (i = t === ~~t ? t : !0 === t ? h : c, "string" == typeof e ? n.input = o.string2buf(e) : "[object ArrayBuffer]" === l.call(e) ? n.input = new Uint8Array(e) : n.input = e, n.next_in = 0, n.avail_in = n.input.length;;) {
          if (0 === n.avail_out && (n.output = new Uint8Array(r), n.next_out = 0, n.avail_out = r), (i === d || i === u) && n.avail_out <= 6) this.onData(n.output.subarray(0, n.next_out)), n.avail_out = 0;else {
            if (a = s.deflate(n, i), a === p) return n.next_out > 0 && this.onData(n.output.subarray(0, n.next_out)), a = s.deflateEnd(this.strm), this.onEnd(a), this.ended = !0, a === f;if (0 !== n.avail_out) {
              if (i > 0 && n.next_out > 0) this.onData(n.output.subarray(0, n.next_out)), n.avail_out = 0;else if (0 === n.avail_in) break;
            } else this.onData(n.output);
          }
        }return !0;
      }, y.prototype.onData = function (e) {
        this.chunks.push(e);
      }, y.prototype.onEnd = function (e) {
        e === f && (this.result = r.flattenChunks(this.chunks)), this.chunks = [], this.err = e, this.msg = this.strm.msg;
      }, e.exports.Deflate = y, e.exports.deflate = w, e.exports.deflateRaw = function (e, t) {
        return (t = t || {}).raw = !0, w(e, t);
      }, e.exports.gzip = function (e, t) {
        return (t = t || {}).gzip = !0, w(e, t);
      }, e.exports.constants = n( /*! ./zlib/constants */"./node_modules/pako/lib/zlib/constants.js");
    }, "./node_modules/pako/lib/inflate.js":
    /*!******************************************!*\
      !*** ./node_modules/pako/lib/inflate.js ***!
      \******************************************/function node_modulesPakoLibInflateJs(e, t, n) {
      "use strict";
      var s = n( /*! ./zlib/inflate */"./node_modules/pako/lib/zlib/inflate.js"),
          r = n( /*! ./utils/common */"./node_modules/pako/lib/utils/common.js"),
          o = n( /*! ./utils/strings */"./node_modules/pako/lib/utils/strings.js"),
          a = n( /*! ./zlib/messages */"./node_modules/pako/lib/zlib/messages.js"),
          i = n( /*! ./zlib/zstream */"./node_modules/pako/lib/zlib/zstream.js"),
          l = n( /*! ./zlib/gzheader */"./node_modules/pako/lib/zlib/gzheader.js"),
          c = Object.prototype.toString,
          _n110 = n( /*! ./zlib/constants */"./node_modules/pako/lib/zlib/constants.js"),
          d = _n110.Z_NO_FLUSH,
          u = _n110.Z_FINISH,
          h = _n110.Z_OK,
          f = _n110.Z_STREAM_END,
          p = _n110.Z_NEED_DICT,
          b = _n110.Z_STREAM_ERROR,
          g = _n110.Z_DATA_ERROR,
          m = _n110.Z_MEM_ERROR;function y(e) {
        this.options = r.assign({ chunkSize: 65536, windowBits: 15, to: "" }, e || {});var t = this.options;t.raw && t.windowBits >= 0 && t.windowBits < 16 && (t.windowBits = -t.windowBits, 0 === t.windowBits && (t.windowBits = -15)), !(t.windowBits >= 0 && t.windowBits < 16) || e && e.windowBits || (t.windowBits += 32), t.windowBits > 15 && t.windowBits < 48 && 0 == (15 & t.windowBits) && (t.windowBits |= 15), this.err = 0, this.msg = "", this.ended = !1, this.chunks = [], this.strm = new i(), this.strm.avail_out = 0;var n = s.inflateInit2(this.strm, t.windowBits);if (n !== h) throw new Error(a[n]);if (this.header = new l(), s.inflateGetHeader(this.strm, this.header), t.dictionary && ("string" == typeof t.dictionary ? t.dictionary = o.string2buf(t.dictionary) : "[object ArrayBuffer]" === c.call(t.dictionary) && (t.dictionary = new Uint8Array(t.dictionary)), t.raw && (n = s.inflateSetDictionary(this.strm, t.dictionary), n !== h))) throw new Error(a[n]);
      }function w(e, t) {
        var n = new y(t);if (n.push(e), n.err) throw n.msg || a[n.err];return n.result;
      }y.prototype.push = function (e, t) {
        var n = this.strm,
            r = this.options.chunkSize,
            a = this.options.dictionary;var i = void 0,
            l = void 0,
            y = void 0;if (this.ended) return !1;for (l = t === ~~t ? t : !0 === t ? u : d, "[object ArrayBuffer]" === c.call(e) ? n.input = new Uint8Array(e) : n.input = e, n.next_in = 0, n.avail_in = n.input.length;;) {
          for (0 === n.avail_out && (n.output = new Uint8Array(r), n.next_out = 0, n.avail_out = r), i = s.inflate(n, l), i === p && a && (i = s.inflateSetDictionary(n, a), i === h ? i = s.inflate(n, l) : i === g && (i = p)); n.avail_in > 0 && i === f && n.state.wrap > 0 && 0 !== e[n.next_in];) {
            s.inflateReset(n), i = s.inflate(n, l);
          }switch (i) {case b:case g:case p:case m:
              return this.onEnd(i), this.ended = !0, !1;}if (y = n.avail_out, n.next_out && (0 === n.avail_out || i === f)) if ("string" === this.options.to) {
            var _e105 = o.utf8border(n.output, n.next_out),
                _t89 = n.next_out - _e105,
                _s51 = o.buf2string(n.output, _e105);n.next_out = _t89, n.avail_out = r - _t89, _t89 && n.output.set(n.output.subarray(_e105, _e105 + _t89), 0), this.onData(_s51);
          } else this.onData(n.output.length === n.next_out ? n.output : n.output.subarray(0, n.next_out));if (i !== h || 0 !== y) {
            if (i === f) return i = s.inflateEnd(this.strm), this.onEnd(i), this.ended = !0, !0;if (0 === n.avail_in) break;
          }
        }return !0;
      }, y.prototype.onData = function (e) {
        this.chunks.push(e);
      }, y.prototype.onEnd = function (e) {
        e === h && ("string" === this.options.to ? this.result = this.chunks.join("") : this.result = r.flattenChunks(this.chunks)), this.chunks = [], this.err = e, this.msg = this.strm.msg;
      }, e.exports.Inflate = y, e.exports.inflate = w, e.exports.inflateRaw = function (e, t) {
        return (t = t || {}).raw = !0, w(e, t);
      }, e.exports.ungzip = w, e.exports.constants = n( /*! ./zlib/constants */"./node_modules/pako/lib/zlib/constants.js");
    }, "./node_modules/pako/lib/utils/common.js":
    /*!***********************************************!*\
      !*** ./node_modules/pako/lib/utils/common.js ***!
      \***********************************************/function node_modulesPakoLibUtilsCommonJs(e) {
      "use strict";
      var t = function t(e, _t90) {
        return Object.prototype.hasOwnProperty.call(e, _t90);
      };e.exports.assign = function (e) {
        var n = Array.prototype.slice.call(arguments, 1);for (; n.length;) {
          var s = n.shift();if (s) {
            if ("object" != (typeof s === "undefined" ? "undefined" : _typeof(s))) throw new TypeError(s + "must be non-object");for (var _n111 in s) {
              t(s, _n111) && (e[_n111] = s[_n111]);
            }
          }
        }return e;
      }, e.exports.flattenChunks = function (e) {
        var t = 0;for (var _n112 = 0, s = e.length; _n112 < s; _n112++) {
          t += e[_n112].length;
        }var n = new Uint8Array(t);for (var _t91 = 0, _s52 = 0, r = e.length; _t91 < r; _t91++) {
          var r = e[_t91];n.set(r, _s52), _s52 += r.length;
        }return n;
      };
    }, "./node_modules/pako/lib/utils/strings.js":
    /*!************************************************!*\
      !*** ./node_modules/pako/lib/utils/strings.js ***!
      \************************************************/function node_modulesPakoLibUtilsStringsJs(e) {
      "use strict";
      var t = !0;try {
        String.fromCharCode.apply(null, new Uint8Array(1));
      } catch (e) {
        t = !1;
      }var n = new Uint8Array(256);for (var _e106 = 0; _e106 < 256; _e106++) {
        n[_e106] = _e106 >= 252 ? 6 : _e106 >= 248 ? 5 : _e106 >= 240 ? 4 : _e106 >= 224 ? 3 : _e106 >= 192 ? 2 : 1;
      }n[254] = n[254] = 1, e.exports.string2buf = function (e) {
        var t = void 0,
            n = void 0,
            s = void 0,
            r = void 0,
            o = void 0,
            a = e.length,
            i = 0;for (r = 0; r < a; r++) {
          n = e.charCodeAt(r), 55296 == (64512 & n) && r + 1 < a && (s = e.charCodeAt(r + 1), 56320 == (64512 & s) && (n = 65536 + (n - 55296 << 10) + (s - 56320), r++)), i += n < 128 ? 1 : n < 2048 ? 2 : n < 65536 ? 3 : 4;
        }for (t = new Uint8Array(i), o = 0, r = 0; o < i; r++) {
          n = e.charCodeAt(r), 55296 == (64512 & n) && r + 1 < a && (s = e.charCodeAt(r + 1), 56320 == (64512 & s) && (n = 65536 + (n - 55296 << 10) + (s - 56320), r++)), n < 128 ? t[o++] = n : n < 2048 ? (t[o++] = 192 | n >>> 6, t[o++] = 128 | 63 & n) : n < 65536 ? (t[o++] = 224 | n >>> 12, t[o++] = 128 | n >>> 6 & 63, t[o++] = 128 | 63 & n) : (t[o++] = 240 | n >>> 18, t[o++] = 128 | n >>> 12 & 63, t[o++] = 128 | n >>> 6 & 63, t[o++] = 128 | 63 & n);
        }return t;
      }, e.exports.buf2string = function (e, s) {
        var r = void 0,
            o = void 0;var a = s || e.length,
            i = new Array(2 * a);for (o = 0, r = 0; r < a;) {
          var _t92 = e[r++];if (_t92 < 128) {
            i[o++] = _t92;continue;
          }var _s53 = n[_t92];if (_s53 > 4) i[o++] = 65533, r += _s53 - 1;else {
            for (_t92 &= 2 === _s53 ? 31 : 3 === _s53 ? 15 : 7; _s53 > 1 && r < a;) {
              _t92 = _t92 << 6 | 63 & e[r++], _s53--;
            }_s53 > 1 ? i[o++] = 65533 : _t92 < 65536 ? i[o++] = _t92 : (_t92 -= 65536, i[o++] = 55296 | _t92 >> 10 & 1023, i[o++] = 56320 | 1023 & _t92);
          }
        }return function (e, n) {
          if (n < 65534 && e.subarray && t) return String.fromCharCode.apply(null, e.length === n ? e : e.subarray(0, n));var s = "";for (var _t93 = 0; _t93 < n; _t93++) {
            s += String.fromCharCode(e[_t93]);
          }return s;
        }(i, o);
      }, e.exports.utf8border = function (e, t) {
        (t = t || e.length) > e.length && (t = e.length);var s = t - 1;for (; s >= 0 && 128 == (192 & e[s]);) {
          s--;
        }return s < 0 || 0 === s ? t : s + n[e[s]] > t ? s : t;
      };
    }, "./node_modules/pako/lib/zlib/adler32.js":
    /*!***********************************************!*\
      !*** ./node_modules/pako/lib/zlib/adler32.js ***!
      \***********************************************/function node_modulesPakoLibZlibAdler32Js(e) {
      "use strict";
      e.exports = function (e, t, n, s) {
        var r = 65535 & e | 0,
            o = e >>> 16 & 65535 | 0,
            a = 0;for (; 0 !== n;) {
          a = n > 2e3 ? 2e3 : n, n -= a;do {
            r = r + t[s++] | 0, o = o + r | 0;
          } while (--a);r %= 65521, o %= 65521;
        }return r | o << 16 | 0;
      };
    }, "./node_modules/pako/lib/zlib/constants.js":
    /*!*************************************************!*\
      !*** ./node_modules/pako/lib/zlib/constants.js ***!
      \*************************************************/function node_modulesPakoLibZlibConstantsJs(e) {
      "use strict";
      e.exports = { Z_NO_FLUSH: 0, Z_PARTIAL_FLUSH: 1, Z_SYNC_FLUSH: 2, Z_FULL_FLUSH: 3, Z_FINISH: 4, Z_BLOCK: 5, Z_TREES: 6, Z_OK: 0, Z_STREAM_END: 1, Z_NEED_DICT: 2, Z_ERRNO: -1, Z_STREAM_ERROR: -2, Z_DATA_ERROR: -3, Z_MEM_ERROR: -4, Z_BUF_ERROR: -5, Z_NO_COMPRESSION: 0, Z_BEST_SPEED: 1, Z_BEST_COMPRESSION: 9, Z_DEFAULT_COMPRESSION: -1, Z_FILTERED: 1, Z_HUFFMAN_ONLY: 2, Z_RLE: 3, Z_FIXED: 4, Z_DEFAULT_STRATEGY: 0, Z_BINARY: 0, Z_TEXT: 1, Z_UNKNOWN: 2, Z_DEFLATED: 8 };
    }, "./node_modules/pako/lib/zlib/crc32.js":
    /*!*********************************************!*\
      !*** ./node_modules/pako/lib/zlib/crc32.js ***!
      \*********************************************/function node_modulesPakoLibZlibCrc32Js(e) {
      "use strict";
      var t = new Uint32Array(function () {
        var e = void 0,
            t = [];for (var n = 0; n < 256; n++) {
          e = n;for (var s = 0; s < 8; s++) {
            e = 1 & e ? 3988292384 ^ e >>> 1 : e >>> 1;
          }t[n] = e;
        }return t;
      }());e.exports = function (e, n, s, r) {
        var o = t,
            a = r + s;e ^= -1;for (var _t94 = r; _t94 < a; _t94++) {
          e = e >>> 8 ^ o[255 & (e ^ n[_t94])];
        }return -1 ^ e;
      };
    }, "./node_modules/pako/lib/zlib/deflate.js":
    /*!***********************************************!*\
      !*** ./node_modules/pako/lib/zlib/deflate.js ***!
      \***********************************************/function node_modulesPakoLibZlibDeflateJs(e, t, n) {
      "use strict";

      var _n113 = n( /*! ./trees */"./node_modules/pako/lib/zlib/trees.js"),
          s = _n113._tr_init,
          r = _n113._tr_stored_block,
          o = _n113._tr_flush_block,
          a = _n113._tr_tally,
          i = _n113._tr_align,
          l = n( /*! ./adler32 */"./node_modules/pako/lib/zlib/adler32.js"),
          c = n( /*! ./crc32 */"./node_modules/pako/lib/zlib/crc32.js"),
          d = n( /*! ./messages */"./node_modules/pako/lib/zlib/messages.js"),
          _n114 = n( /*! ./constants */"./node_modules/pako/lib/zlib/constants.js"),
          u = _n114.Z_NO_FLUSH,
          h = _n114.Z_PARTIAL_FLUSH,
          f = _n114.Z_FULL_FLUSH,
          p = _n114.Z_FINISH,
          b = _n114.Z_BLOCK,
          g = _n114.Z_OK,
          m = _n114.Z_STREAM_END,
          y = _n114.Z_STREAM_ERROR,
          w = _n114.Z_DATA_ERROR,
          _ = _n114.Z_BUF_ERROR,
          I = _n114.Z_DEFAULT_COMPRESSION,
          v = _n114.Z_FILTERED,
          k = _n114.Z_HUFFMAN_ONLY,
          x = _n114.Z_RLE,
          j = _n114.Z_FIXED,
          E = _n114.Z_DEFAULT_STRATEGY,
          O = _n114.Z_UNKNOWN,
          A = _n114.Z_DEFLATED,
          R = 258,
          C = 262,
          V = 103,
          S = 113,
          N = 666,
          T = function T(e, t) {
        return e.msg = d[t], t;
      },
          U = function U(e) {
        return (e << 1) - (e > 4 ? 9 : 0);
      },
          L = function L(e) {
        var t = e.length;for (; --t >= 0;) {
          e[t] = 0;
        }
      };

      var B = function B(e, t, n) {
        return (t << e.hash_shift ^ n) & e.hash_mask;
      };var z = function z(e) {
        var t = e.state;var n = t.pending;n > e.avail_out && (n = e.avail_out), 0 !== n && (e.output.set(t.pending_buf.subarray(t.pending_out, t.pending_out + n), e.next_out), e.next_out += n, t.pending_out += n, e.total_out += n, e.avail_out -= n, t.pending -= n, 0 === t.pending && (t.pending_out = 0));
      },
          D = function D(e, t) {
        o(e, e.block_start >= 0 ? e.block_start : -1, e.strstart - e.block_start, t), e.block_start = e.strstart, z(e.strm);
      },
          H = function H(e, t) {
        e.pending_buf[e.pending++] = t;
      },
          $ = function $(e, t) {
        e.pending_buf[e.pending++] = t >>> 8 & 255, e.pending_buf[e.pending++] = 255 & t;
      },
          M = function M(e, t, n, s) {
        var r = e.avail_in;return r > s && (r = s), 0 === r ? 0 : (e.avail_in -= r, t.set(e.input.subarray(e.next_in, e.next_in + r), n), 1 === e.state.wrap ? e.adler = l(e.adler, t, r, n) : 2 === e.state.wrap && (e.adler = c(e.adler, t, r, n)), e.next_in += r, e.total_in += r, r);
      },
          P = function P(e, t) {
        var n = void 0,
            s = void 0,
            r = e.max_chain_length,
            o = e.strstart,
            a = e.prev_length,
            i = e.nice_match;var l = e.strstart > e.w_size - C ? e.strstart - (e.w_size - C) : 0,
            c = e.window,
            d = e.w_mask,
            u = e.prev,
            h = e.strstart + R;var f = c[o + a - 1],
            p = c[o + a];e.prev_length >= e.good_match && (r >>= 2), i > e.lookahead && (i = e.lookahead);do {
          if (n = t, c[n + a] === p && c[n + a - 1] === f && c[n] === c[o] && c[++n] === c[o + 1]) {
            o += 2, n++;do {} while (c[++o] === c[++n] && c[++o] === c[++n] && c[++o] === c[++n] && c[++o] === c[++n] && c[++o] === c[++n] && c[++o] === c[++n] && c[++o] === c[++n] && c[++o] === c[++n] && o < h);if (s = R - (h - o), o = h - R, s > a) {
              if (e.match_start = t, a = s, s >= i) break;f = c[o + a - 1], p = c[o + a];
            }
          }
        } while ((t = u[t & d]) > l && 0 != --r);return a <= e.lookahead ? a : e.lookahead;
      },
          F = function F(e) {
        var t = e.w_size;var n = void 0,
            s = void 0,
            r = void 0,
            o = void 0,
            a = void 0;do {
          if (o = e.window_size - e.lookahead - e.strstart, e.strstart >= t + (t - C)) {
            e.window.set(e.window.subarray(t, t + t), 0), e.match_start -= t, e.strstart -= t, e.block_start -= t, s = e.hash_size, n = s;do {
              r = e.head[--n], e.head[n] = r >= t ? r - t : 0;
            } while (--s);s = t, n = s;do {
              r = e.prev[--n], e.prev[n] = r >= t ? r - t : 0;
            } while (--s);o += t;
          }if (0 === e.strm.avail_in) break;if (s = M(e.strm, e.window, e.strstart + e.lookahead, o), e.lookahead += s, e.lookahead + e.insert >= 3) for (a = e.strstart - e.insert, e.ins_h = e.window[a], e.ins_h = B(e, e.ins_h, e.window[a + 1]); e.insert && (e.ins_h = B(e, e.ins_h, e.window[a + 3 - 1]), e.prev[a & e.w_mask] = e.head[e.ins_h], e.head[e.ins_h] = a, a++, e.insert--, !(e.lookahead + e.insert < 3));) {}
        } while (e.lookahead < C && 0 !== e.strm.avail_in);
      },
          q = function q(e, t) {
        var n = void 0,
            s = void 0;for (;;) {
          if (e.lookahead < C) {
            if (F(e), e.lookahead < C && t === u) return 1;if (0 === e.lookahead) break;
          }if (n = 0, e.lookahead >= 3 && (e.ins_h = B(e, e.ins_h, e.window[e.strstart + 3 - 1]), n = e.prev[e.strstart & e.w_mask] = e.head[e.ins_h], e.head[e.ins_h] = e.strstart), 0 !== n && e.strstart - n <= e.w_size - C && (e.match_length = P(e, n)), e.match_length >= 3) {
            if (s = a(e, e.strstart - e.match_start, e.match_length - 3), e.lookahead -= e.match_length, e.match_length <= e.max_lazy_match && e.lookahead >= 3) {
              e.match_length--;do {
                e.strstart++, e.ins_h = B(e, e.ins_h, e.window[e.strstart + 3 - 1]), n = e.prev[e.strstart & e.w_mask] = e.head[e.ins_h], e.head[e.ins_h] = e.strstart;
              } while (0 != --e.match_length);e.strstart++;
            } else e.strstart += e.match_length, e.match_length = 0, e.ins_h = e.window[e.strstart], e.ins_h = B(e, e.ins_h, e.window[e.strstart + 1]);
          } else s = a(e, 0, e.window[e.strstart]), e.lookahead--, e.strstart++;if (s && (D(e, !1), 0 === e.strm.avail_out)) return 1;
        }return e.insert = e.strstart < 2 ? e.strstart : 2, t === p ? (D(e, !0), 0 === e.strm.avail_out ? 3 : 4) : e.last_lit && (D(e, !1), 0 === e.strm.avail_out) ? 1 : 2;
      },
          Z = function Z(e, t) {
        var n = void 0,
            s = void 0,
            r = void 0;for (;;) {
          if (e.lookahead < C) {
            if (F(e), e.lookahead < C && t === u) return 1;if (0 === e.lookahead) break;
          }if (n = 0, e.lookahead >= 3 && (e.ins_h = B(e, e.ins_h, e.window[e.strstart + 3 - 1]), n = e.prev[e.strstart & e.w_mask] = e.head[e.ins_h], e.head[e.ins_h] = e.strstart), e.prev_length = e.match_length, e.prev_match = e.match_start, e.match_length = 2, 0 !== n && e.prev_length < e.max_lazy_match && e.strstart - n <= e.w_size - C && (e.match_length = P(e, n), e.match_length <= 5 && (e.strategy === v || 3 === e.match_length && e.strstart - e.match_start > 4096) && (e.match_length = 2)), e.prev_length >= 3 && e.match_length <= e.prev_length) {
            r = e.strstart + e.lookahead - 3, s = a(e, e.strstart - 1 - e.prev_match, e.prev_length - 3), e.lookahead -= e.prev_length - 1, e.prev_length -= 2;do {
              ++e.strstart <= r && (e.ins_h = B(e, e.ins_h, e.window[e.strstart + 3 - 1]), n = e.prev[e.strstart & e.w_mask] = e.head[e.ins_h], e.head[e.ins_h] = e.strstart);
            } while (0 != --e.prev_length);if (e.match_available = 0, e.match_length = 2, e.strstart++, s && (D(e, !1), 0 === e.strm.avail_out)) return 1;
          } else if (e.match_available) {
            if (s = a(e, 0, e.window[e.strstart - 1]), s && D(e, !1), e.strstart++, e.lookahead--, 0 === e.strm.avail_out) return 1;
          } else e.match_available = 1, e.strstart++, e.lookahead--;
        }return e.match_available && (s = a(e, 0, e.window[e.strstart - 1]), e.match_available = 0), e.insert = e.strstart < 2 ? e.strstart : 2, t === p ? (D(e, !0), 0 === e.strm.avail_out ? 3 : 4) : e.last_lit && (D(e, !1), 0 === e.strm.avail_out) ? 1 : 2;
      };function G(e, t, n, s, r) {
        this.good_length = e, this.max_lazy = t, this.nice_length = n, this.max_chain = s, this.func = r;
      }var K = [new G(0, 0, 0, 0, function (e, t) {
        var n = 65535;for (n > e.pending_buf_size - 5 && (n = e.pending_buf_size - 5);;) {
          if (e.lookahead <= 1) {
            if (F(e), 0 === e.lookahead && t === u) return 1;if (0 === e.lookahead) break;
          }e.strstart += e.lookahead, e.lookahead = 0;var _s54 = e.block_start + n;if ((0 === e.strstart || e.strstart >= _s54) && (e.lookahead = e.strstart - _s54, e.strstart = _s54, D(e, !1), 0 === e.strm.avail_out)) return 1;if (e.strstart - e.block_start >= e.w_size - C && (D(e, !1), 0 === e.strm.avail_out)) return 1;
        }return e.insert = 0, t === p ? (D(e, !0), 0 === e.strm.avail_out ? 3 : 4) : (e.strstart > e.block_start && (D(e, !1), e.strm.avail_out), 1);
      }), new G(4, 4, 8, 4, q), new G(4, 5, 16, 8, q), new G(4, 6, 32, 32, q), new G(4, 4, 16, 16, Z), new G(8, 16, 32, 32, Z), new G(8, 16, 128, 128, Z), new G(8, 32, 128, 256, Z), new G(32, 128, 258, 1024, Z), new G(32, 258, 258, 4096, Z)];function W() {
        this.strm = null, this.status = 0, this.pending_buf = null, this.pending_buf_size = 0, this.pending_out = 0, this.pending = 0, this.wrap = 0, this.gzhead = null, this.gzindex = 0, this.method = A, this.last_flush = -1, this.w_size = 0, this.w_bits = 0, this.w_mask = 0, this.window = null, this.window_size = 0, this.prev = null, this.head = null, this.ins_h = 0, this.hash_size = 0, this.hash_bits = 0, this.hash_mask = 0, this.hash_shift = 0, this.block_start = 0, this.match_length = 0, this.prev_match = 0, this.match_available = 0, this.strstart = 0, this.match_start = 0, this.lookahead = 0, this.prev_length = 0, this.max_chain_length = 0, this.max_lazy_match = 0, this.level = 0, this.strategy = 0, this.good_match = 0, this.nice_match = 0, this.dyn_ltree = new Uint16Array(1146), this.dyn_dtree = new Uint16Array(122), this.bl_tree = new Uint16Array(78), L(this.dyn_ltree), L(this.dyn_dtree), L(this.bl_tree), this.l_desc = null, this.d_desc = null, this.bl_desc = null, this.bl_count = new Uint16Array(16), this.heap = new Uint16Array(573), L(this.heap), this.heap_len = 0, this.heap_max = 0, this.depth = new Uint16Array(573), L(this.depth), this.l_buf = 0, this.lit_bufsize = 0, this.last_lit = 0, this.d_buf = 0, this.opt_len = 0, this.static_len = 0, this.matches = 0, this.insert = 0, this.bi_buf = 0, this.bi_valid = 0;
      }var Y = function Y(e) {
        if (!e || !e.state) return T(e, y);e.total_in = e.total_out = 0, e.data_type = O;var t = e.state;return t.pending = 0, t.pending_out = 0, t.wrap < 0 && (t.wrap = -t.wrap), t.status = t.wrap ? 42 : S, e.adler = 2 === t.wrap ? 0 : 1, t.last_flush = u, s(t), g;
      },
          J = function J(e) {
        var t = Y(e);var n;return t === g && ((n = e.state).window_size = 2 * n.w_size, L(n.head), n.max_lazy_match = K[n.level].max_lazy, n.good_match = K[n.level].good_length, n.nice_match = K[n.level].nice_length, n.max_chain_length = K[n.level].max_chain, n.strstart = 0, n.block_start = 0, n.lookahead = 0, n.insert = 0, n.match_length = n.prev_length = 2, n.match_available = 0, n.ins_h = 0), t;
      },
          X = function X(e, t, n, s, r, o) {
        if (!e) return y;var a = 1;if (t === I && (t = 6), s < 0 ? (a = 0, s = -s) : s > 15 && (a = 2, s -= 16), r < 1 || r > 9 || n !== A || s < 8 || s > 15 || t < 0 || t > 9 || o < 0 || o > j) return T(e, y);8 === s && (s = 9);var i = new W();return e.state = i, i.strm = e, i.wrap = a, i.gzhead = null, i.w_bits = s, i.w_size = 1 << i.w_bits, i.w_mask = i.w_size - 1, i.hash_bits = r + 7, i.hash_size = 1 << i.hash_bits, i.hash_mask = i.hash_size - 1, i.hash_shift = ~~((i.hash_bits + 3 - 1) / 3), i.window = new Uint8Array(2 * i.w_size), i.head = new Uint16Array(i.hash_size), i.prev = new Uint16Array(i.w_size), i.lit_bufsize = 1 << r + 6, i.pending_buf_size = 4 * i.lit_bufsize, i.pending_buf = new Uint8Array(i.pending_buf_size), i.d_buf = 1 * i.lit_bufsize, i.l_buf = 3 * i.lit_bufsize, i.level = t, i.strategy = o, i.method = n, J(e);
      };e.exports.deflateInit = function (e, t) {
        return X(e, t, A, 15, 8, E);
      }, e.exports.deflateInit2 = X, e.exports.deflateReset = J, e.exports.deflateResetKeep = Y, e.exports.deflateSetHeader = function (e, t) {
        return e && e.state ? 2 !== e.state.wrap ? y : (e.state.gzhead = t, g) : y;
      }, e.exports.deflate = function (e, t) {
        var n = void 0,
            s = void 0;if (!e || !e.state || t > b || t < 0) return e ? T(e, y) : y;var o = e.state;if (!e.output || !e.input && 0 !== e.avail_in || o.status === N && t !== p) return T(e, 0 === e.avail_out ? _ : y);o.strm = e;var l = o.last_flush;if (o.last_flush = t, 42 === o.status) if (2 === o.wrap) e.adler = 0, H(o, 31), H(o, 139), H(o, 8), o.gzhead ? (H(o, (o.gzhead.text ? 1 : 0) + (o.gzhead.hcrc ? 2 : 0) + (o.gzhead.extra ? 4 : 0) + (o.gzhead.name ? 8 : 0) + (o.gzhead.comment ? 16 : 0)), H(o, 255 & o.gzhead.time), H(o, o.gzhead.time >> 8 & 255), H(o, o.gzhead.time >> 16 & 255), H(o, o.gzhead.time >> 24 & 255), H(o, 9 === o.level ? 2 : o.strategy >= k || o.level < 2 ? 4 : 0), H(o, 255 & o.gzhead.os), o.gzhead.extra && o.gzhead.extra.length && (H(o, 255 & o.gzhead.extra.length), H(o, o.gzhead.extra.length >> 8 & 255)), o.gzhead.hcrc && (e.adler = c(e.adler, o.pending_buf, o.pending, 0)), o.gzindex = 0, o.status = 69) : (H(o, 0), H(o, 0), H(o, 0), H(o, 0), H(o, 0), H(o, 9 === o.level ? 2 : o.strategy >= k || o.level < 2 ? 4 : 0), H(o, 3), o.status = S);else {
          var _t95 = A + (o.w_bits - 8 << 4) << 8,
              _n115 = -1;_n115 = o.strategy >= k || o.level < 2 ? 0 : o.level < 6 ? 1 : 6 === o.level ? 2 : 3, _t95 |= _n115 << 6, 0 !== o.strstart && (_t95 |= 32), _t95 += 31 - _t95 % 31, o.status = S, $(o, _t95), 0 !== o.strstart && ($(o, e.adler >>> 16), $(o, 65535 & e.adler)), e.adler = 1;
        }if (69 === o.status) if (o.gzhead.extra) {
          for (n = o.pending; o.gzindex < (65535 & o.gzhead.extra.length) && (o.pending !== o.pending_buf_size || (o.gzhead.hcrc && o.pending > n && (e.adler = c(e.adler, o.pending_buf, o.pending - n, n)), z(e), n = o.pending, o.pending !== o.pending_buf_size));) {
            H(o, 255 & o.gzhead.extra[o.gzindex]), o.gzindex++;
          }o.gzhead.hcrc && o.pending > n && (e.adler = c(e.adler, o.pending_buf, o.pending - n, n)), o.gzindex === o.gzhead.extra.length && (o.gzindex = 0, o.status = 73);
        } else o.status = 73;if (73 === o.status) if (o.gzhead.name) {
          n = o.pending;do {
            if (o.pending === o.pending_buf_size && (o.gzhead.hcrc && o.pending > n && (e.adler = c(e.adler, o.pending_buf, o.pending - n, n)), z(e), n = o.pending, o.pending === o.pending_buf_size)) {
              s = 1;break;
            }s = o.gzindex < o.gzhead.name.length ? 255 & o.gzhead.name.charCodeAt(o.gzindex++) : 0, H(o, s);
          } while (0 !== s);o.gzhead.hcrc && o.pending > n && (e.adler = c(e.adler, o.pending_buf, o.pending - n, n)), 0 === s && (o.gzindex = 0, o.status = 91);
        } else o.status = 91;if (91 === o.status) if (o.gzhead.comment) {
          n = o.pending;do {
            if (o.pending === o.pending_buf_size && (o.gzhead.hcrc && o.pending > n && (e.adler = c(e.adler, o.pending_buf, o.pending - n, n)), z(e), n = o.pending, o.pending === o.pending_buf_size)) {
              s = 1;break;
            }s = o.gzindex < o.gzhead.comment.length ? 255 & o.gzhead.comment.charCodeAt(o.gzindex++) : 0, H(o, s);
          } while (0 !== s);o.gzhead.hcrc && o.pending > n && (e.adler = c(e.adler, o.pending_buf, o.pending - n, n)), 0 === s && (o.status = V);
        } else o.status = V;if (o.status === V && (o.gzhead.hcrc ? (o.pending + 2 > o.pending_buf_size && z(e), o.pending + 2 <= o.pending_buf_size && (H(o, 255 & e.adler), H(o, e.adler >> 8 & 255), e.adler = 0, o.status = S)) : o.status = S), 0 !== o.pending) {
          if (z(e), 0 === e.avail_out) return o.last_flush = -1, g;
        } else if (0 === e.avail_in && U(t) <= U(l) && t !== p) return T(e, _);if (o.status === N && 0 !== e.avail_in) return T(e, _);if (0 !== e.avail_in || 0 !== o.lookahead || t !== u && o.status !== N) {
          var _n116 = o.strategy === k ? function (e, t) {
            var n = void 0;for (;;) {
              if (0 === e.lookahead && (F(e), 0 === e.lookahead)) {
                if (t === u) return 1;break;
              }if (e.match_length = 0, n = a(e, 0, e.window[e.strstart]), e.lookahead--, e.strstart++, n && (D(e, !1), 0 === e.strm.avail_out)) return 1;
            }return e.insert = 0, t === p ? (D(e, !0), 0 === e.strm.avail_out ? 3 : 4) : e.last_lit && (D(e, !1), 0 === e.strm.avail_out) ? 1 : 2;
          }(o, t) : o.strategy === x ? function (e, t) {
            var n = void 0,
                s = void 0,
                r = void 0,
                o = void 0;var i = e.window;for (;;) {
              if (e.lookahead <= R) {
                if (F(e), e.lookahead <= R && t === u) return 1;if (0 === e.lookahead) break;
              }if (e.match_length = 0, e.lookahead >= 3 && e.strstart > 0 && (r = e.strstart - 1, s = i[r], s === i[++r] && s === i[++r] && s === i[++r])) {
                o = e.strstart + R;do {} while (s === i[++r] && s === i[++r] && s === i[++r] && s === i[++r] && s === i[++r] && s === i[++r] && s === i[++r] && s === i[++r] && r < o);e.match_length = R - (o - r), e.match_length > e.lookahead && (e.match_length = e.lookahead);
              }if (e.match_length >= 3 ? (n = a(e, 1, e.match_length - 3), e.lookahead -= e.match_length, e.strstart += e.match_length, e.match_length = 0) : (n = a(e, 0, e.window[e.strstart]), e.lookahead--, e.strstart++), n && (D(e, !1), 0 === e.strm.avail_out)) return 1;
            }return e.insert = 0, t === p ? (D(e, !0), 0 === e.strm.avail_out ? 3 : 4) : e.last_lit && (D(e, !1), 0 === e.strm.avail_out) ? 1 : 2;
          }(o, t) : K[o.level].func(o, t);if (3 !== _n116 && 4 !== _n116 || (o.status = N), 1 === _n116 || 3 === _n116) return 0 === e.avail_out && (o.last_flush = -1), g;if (2 === _n116 && (t === h ? i(o) : t !== b && (r(o, 0, 0, !1), t === f && (L(o.head), 0 === o.lookahead && (o.strstart = 0, o.block_start = 0, o.insert = 0))), z(e), 0 === e.avail_out)) return o.last_flush = -1, g;
        }return t !== p ? g : o.wrap <= 0 ? m : (2 === o.wrap ? (H(o, 255 & e.adler), H(o, e.adler >> 8 & 255), H(o, e.adler >> 16 & 255), H(o, e.adler >> 24 & 255), H(o, 255 & e.total_in), H(o, e.total_in >> 8 & 255), H(o, e.total_in >> 16 & 255), H(o, e.total_in >> 24 & 255)) : ($(o, e.adler >>> 16), $(o, 65535 & e.adler)), z(e), o.wrap > 0 && (o.wrap = -o.wrap), 0 !== o.pending ? g : m);
      }, e.exports.deflateEnd = function (e) {
        if (!e || !e.state) return y;var t = e.state.status;return 42 !== t && 69 !== t && 73 !== t && 91 !== t && t !== V && t !== S && t !== N ? T(e, y) : (e.state = null, t === S ? T(e, w) : g);
      }, e.exports.deflateSetDictionary = function (e, t) {
        var n = t.length;if (!e || !e.state) return y;var s = e.state,
            r = s.wrap;if (2 === r || 1 === r && 42 !== s.status || s.lookahead) return y;if (1 === r && (e.adler = l(e.adler, t, n, 0)), s.wrap = 0, n >= s.w_size) {
          0 === r && (L(s.head), s.strstart = 0, s.block_start = 0, s.insert = 0);var _e107 = new Uint8Array(s.w_size);_e107.set(t.subarray(n - s.w_size, n), 0), t = _e107, n = s.w_size;
        }var o = e.avail_in,
            a = e.next_in,
            i = e.input;for (e.avail_in = n, e.next_in = 0, e.input = t, F(s); s.lookahead >= 3;) {
          var _e108 = s.strstart,
              _t96 = s.lookahead - 2;do {
            s.ins_h = B(s, s.ins_h, s.window[_e108 + 3 - 1]), s.prev[_e108 & s.w_mask] = s.head[s.ins_h], s.head[s.ins_h] = _e108, _e108++;
          } while (--_t96);s.strstart = _e108, s.lookahead = 2, F(s);
        }return s.strstart += s.lookahead, s.block_start = s.strstart, s.insert = s.lookahead, s.lookahead = 0, s.match_length = s.prev_length = 2, s.match_available = 0, e.next_in = a, e.input = i, e.avail_in = o, s.wrap = r, g;
      }, e.exports.deflateInfo = "pako deflate (from Nodeca project)";
    }, "./node_modules/pako/lib/zlib/gzheader.js":
    /*!************************************************!*\
      !*** ./node_modules/pako/lib/zlib/gzheader.js ***!
      \************************************************/function node_modulesPakoLibZlibGzheaderJs(e) {
      "use strict";
      e.exports = function () {
        this.text = 0, this.time = 0, this.xflags = 0, this.os = 0, this.extra = null, this.extra_len = 0, this.name = "", this.comment = "", this.hcrc = 0, this.done = !1;
      };
    }, "./node_modules/pako/lib/zlib/inffast.js":
    /*!***********************************************!*\
      !*** ./node_modules/pako/lib/zlib/inffast.js ***!
      \***********************************************/function node_modulesPakoLibZlibInffastJs(e) {
      "use strict";
      e.exports = function (e, t) {
        var n = void 0,
            s = void 0,
            r = void 0,
            o = void 0,
            a = void 0,
            i = void 0,
            l = void 0,
            c = void 0,
            d = void 0,
            u = void 0,
            h = void 0,
            f = void 0,
            p = void 0,
            b = void 0,
            g = void 0,
            m = void 0,
            y = void 0,
            w = void 0,
            _ = void 0,
            I = void 0,
            v = void 0,
            k = void 0,
            x = void 0,
            j = void 0;var E = e.state;n = e.next_in, x = e.input, s = n + (e.avail_in - 5), r = e.next_out, j = e.output, o = r - (t - e.avail_out), a = r + (e.avail_out - 257), i = E.dmax, l = E.wsize, c = E.whave, d = E.wnext, u = E.window, h = E.hold, f = E.bits, p = E.lencode, b = E.distcode, g = (1 << E.lenbits) - 1, m = (1 << E.distbits) - 1;e: do {
          f < 15 && (h += x[n++] << f, f += 8, h += x[n++] << f, f += 8), y = p[h & g];t: for (;;) {
            if (w = y >>> 24, h >>>= w, f -= w, w = y >>> 16 & 255, 0 === w) j[r++] = 65535 & y;else {
              if (!(16 & w)) {
                if (0 == (64 & w)) {
                  y = p[(65535 & y) + (h & (1 << w) - 1)];continue t;
                }if (32 & w) {
                  E.mode = 12;break e;
                }e.msg = "invalid literal/length code", E.mode = 30;break e;
              }_ = 65535 & y, w &= 15, w && (f < w && (h += x[n++] << f, f += 8), _ += h & (1 << w) - 1, h >>>= w, f -= w), f < 15 && (h += x[n++] << f, f += 8, h += x[n++] << f, f += 8), y = b[h & m];n: for (;;) {
                if (w = y >>> 24, h >>>= w, f -= w, w = y >>> 16 & 255, !(16 & w)) {
                  if (0 == (64 & w)) {
                    y = b[(65535 & y) + (h & (1 << w) - 1)];continue n;
                  }e.msg = "invalid distance code", E.mode = 30;break e;
                }if (I = 65535 & y, w &= 15, f < w && (h += x[n++] << f, f += 8, f < w && (h += x[n++] << f, f += 8)), I += h & (1 << w) - 1, I > i) {
                  e.msg = "invalid distance too far back", E.mode = 30;break e;
                }if (h >>>= w, f -= w, w = r - o, I > w) {
                  if (w = I - w, w > c && E.sane) {
                    e.msg = "invalid distance too far back", E.mode = 30;break e;
                  }if (v = 0, k = u, 0 === d) {
                    if (v += l - w, w < _) {
                      _ -= w;do {
                        j[r++] = u[v++];
                      } while (--w);v = r - I, k = j;
                    }
                  } else if (d < w) {
                    if (v += l + d - w, w -= d, w < _) {
                      _ -= w;do {
                        j[r++] = u[v++];
                      } while (--w);if (v = 0, d < _) {
                        w = d, _ -= w;do {
                          j[r++] = u[v++];
                        } while (--w);v = r - I, k = j;
                      }
                    }
                  } else if (v += d - w, w < _) {
                    _ -= w;do {
                      j[r++] = u[v++];
                    } while (--w);v = r - I, k = j;
                  }for (; _ > 2;) {
                    j[r++] = k[v++], j[r++] = k[v++], j[r++] = k[v++], _ -= 3;
                  }_ && (j[r++] = k[v++], _ > 1 && (j[r++] = k[v++]));
                } else {
                  v = r - I;do {
                    j[r++] = j[v++], j[r++] = j[v++], j[r++] = j[v++], _ -= 3;
                  } while (_ > 2);_ && (j[r++] = j[v++], _ > 1 && (j[r++] = j[v++]));
                }break;
              }
            }break;
          }
        } while (n < s && r < a);_ = f >> 3, n -= _, f -= _ << 3, h &= (1 << f) - 1, e.next_in = n, e.next_out = r, e.avail_in = n < s ? s - n + 5 : 5 - (n - s), e.avail_out = r < a ? a - r + 257 : 257 - (r - a), E.hold = h, E.bits = f;
      };
    }, "./node_modules/pako/lib/zlib/inflate.js":
    /*!***********************************************!*\
      !*** ./node_modules/pako/lib/zlib/inflate.js ***!
      \***********************************************/function node_modulesPakoLibZlibInflateJs(e, t, n) {
      "use strict";
      var s = n( /*! ./adler32 */"./node_modules/pako/lib/zlib/adler32.js"),
          r = n( /*! ./crc32 */"./node_modules/pako/lib/zlib/crc32.js"),
          o = n( /*! ./inffast */"./node_modules/pako/lib/zlib/inffast.js"),
          a = n( /*! ./inftrees */"./node_modules/pako/lib/zlib/inftrees.js"),
          _n117 = n( /*! ./constants */"./node_modules/pako/lib/zlib/constants.js"),
          i = _n117.Z_FINISH,
          l = _n117.Z_BLOCK,
          c = _n117.Z_TREES,
          d = _n117.Z_OK,
          u = _n117.Z_STREAM_END,
          h = _n117.Z_NEED_DICT,
          f = _n117.Z_STREAM_ERROR,
          p = _n117.Z_DATA_ERROR,
          b = _n117.Z_MEM_ERROR,
          g = _n117.Z_BUF_ERROR,
          m = _n117.Z_DEFLATED,
          y = 12,
          w = 30,
          _ = function _(e) {
        return (e >>> 24 & 255) + (e >>> 8 & 65280) + ((65280 & e) << 8) + ((255 & e) << 24);
      };function I() {
        this.mode = 0, this.last = !1, this.wrap = 0, this.havedict = !1, this.flags = 0, this.dmax = 0, this.check = 0, this.total = 0, this.head = null, this.wbits = 0, this.wsize = 0, this.whave = 0, this.wnext = 0, this.window = null, this.hold = 0, this.bits = 0, this.length = 0, this.offset = 0, this.extra = 0, this.lencode = null, this.distcode = null, this.lenbits = 0, this.distbits = 0, this.ncode = 0, this.nlen = 0, this.ndist = 0, this.have = 0, this.next = null, this.lens = new Uint16Array(320), this.work = new Uint16Array(288), this.lendyn = null, this.distdyn = null, this.sane = 0, this.back = 0, this.was = 0;
      }var v = function v(e) {
        if (!e || !e.state) return f;var t = e.state;return e.total_in = e.total_out = t.total = 0, e.msg = "", t.wrap && (e.adler = 1 & t.wrap), t.mode = 1, t.last = 0, t.havedict = 0, t.dmax = 32768, t.head = null, t.hold = 0, t.bits = 0, t.lencode = t.lendyn = new Int32Array(852), t.distcode = t.distdyn = new Int32Array(592), t.sane = 1, t.back = -1, d;
      },
          k = function k(e) {
        if (!e || !e.state) return f;var t = e.state;return t.wsize = 0, t.whave = 0, t.wnext = 0, v(e);
      },
          x = function x(e, t) {
        var n = void 0;if (!e || !e.state) return f;var s = e.state;return t < 0 ? (n = 0, t = -t) : (n = 1 + (t >> 4), t < 48 && (t &= 15)), t && (t < 8 || t > 15) ? f : (null !== s.window && s.wbits !== t && (s.window = null), s.wrap = n, s.wbits = t, k(e));
      },
          j = function j(e, t) {
        if (!e) return f;var n = new I();e.state = n, n.window = null;var s = x(e, t);return s !== d && (e.state = null), s;
      };var E = void 0,
          O = void 0,
          A = !0;var R = function R(e) {
        if (A) {
          E = new Int32Array(512), O = new Int32Array(32);var _t97 = 0;for (; _t97 < 144;) {
            e.lens[_t97++] = 8;
          }for (; _t97 < 256;) {
            e.lens[_t97++] = 9;
          }for (; _t97 < 280;) {
            e.lens[_t97++] = 7;
          }for (; _t97 < 288;) {
            e.lens[_t97++] = 8;
          }for (a(1, e.lens, 0, 288, E, 0, e.work, { bits: 9 }), _t97 = 0; _t97 < 32;) {
            e.lens[_t97++] = 5;
          }a(2, e.lens, 0, 32, O, 0, e.work, { bits: 5 }), A = !1;
        }e.lencode = E, e.lenbits = 9, e.distcode = O, e.distbits = 5;
      },
          C = function C(e, t, n, s) {
        var r = void 0;var o = e.state;return null === o.window && (o.wsize = 1 << o.wbits, o.wnext = 0, o.whave = 0, o.window = new Uint8Array(o.wsize)), s >= o.wsize ? (o.window.set(t.subarray(n - o.wsize, n), 0), o.wnext = 0, o.whave = o.wsize) : (r = o.wsize - o.wnext, r > s && (r = s), o.window.set(t.subarray(n - s, n - s + r), o.wnext), (s -= r) ? (o.window.set(t.subarray(n - s, n), 0), o.wnext = s, o.whave = o.wsize) : (o.wnext += r, o.wnext === o.wsize && (o.wnext = 0), o.whave < o.wsize && (o.whave += r))), 0;
      };e.exports.inflateReset = k, e.exports.inflateReset2 = x, e.exports.inflateResetKeep = v, e.exports.inflateInit = function (e) {
        return j(e, 15);
      }, e.exports.inflateInit2 = j, e.exports.inflate = function (e, t) {
        var n = void 0,
            I = void 0,
            v = void 0,
            k = void 0,
            x = void 0,
            j = void 0,
            E = void 0,
            O = void 0,
            A = void 0,
            V = void 0,
            S = void 0,
            N = void 0,
            T = void 0,
            U = void 0,
            L = void 0,
            B = void 0,
            z = void 0,
            D = void 0,
            H = void 0,
            $ = void 0,
            M = void 0,
            P = void 0,
            F = 0;var q = new Uint8Array(4);var Z = void 0,
            G = void 0;var K = new Uint8Array([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);if (!e || !e.state || !e.output || !e.input && 0 !== e.avail_in) return f;n = e.state, n.mode === y && (n.mode = 13), x = e.next_out, v = e.output, E = e.avail_out, k = e.next_in, I = e.input, j = e.avail_in, O = n.hold, A = n.bits, V = j, S = E, P = d;e: for (;;) {
          switch (n.mode) {case 1:
              if (0 === n.wrap) {
                n.mode = 13;break;
              }for (; A < 16;) {
                if (0 === j) break e;j--, O += I[k++] << A, A += 8;
              }if (2 & n.wrap && 35615 === O) {
                n.check = 0, q[0] = 255 & O, q[1] = O >>> 8 & 255, n.check = r(n.check, q, 2, 0), O = 0, A = 0, n.mode = 2;break;
              }if (n.flags = 0, n.head && (n.head.done = !1), !(1 & n.wrap) || (((255 & O) << 8) + (O >> 8)) % 31) {
                e.msg = "incorrect header check", n.mode = w;break;
              }if ((15 & O) !== m) {
                e.msg = "unknown compression method", n.mode = w;break;
              }if (O >>>= 4, A -= 4, M = 8 + (15 & O), 0 === n.wbits) n.wbits = M;else if (M > n.wbits) {
                e.msg = "invalid window size", n.mode = w;break;
              }n.dmax = 1 << n.wbits, e.adler = n.check = 1, n.mode = 512 & O ? 10 : y, O = 0, A = 0;break;case 2:
              for (; A < 16;) {
                if (0 === j) break e;j--, O += I[k++] << A, A += 8;
              }if (n.flags = O, (255 & n.flags) !== m) {
                e.msg = "unknown compression method", n.mode = w;break;
              }if (57344 & n.flags) {
                e.msg = "unknown header flags set", n.mode = w;break;
              }n.head && (n.head.text = O >> 8 & 1), 512 & n.flags && (q[0] = 255 & O, q[1] = O >>> 8 & 255, n.check = r(n.check, q, 2, 0)), O = 0, A = 0, n.mode = 3;case 3:
              for (; A < 32;) {
                if (0 === j) break e;j--, O += I[k++] << A, A += 8;
              }n.head && (n.head.time = O), 512 & n.flags && (q[0] = 255 & O, q[1] = O >>> 8 & 255, q[2] = O >>> 16 & 255, q[3] = O >>> 24 & 255, n.check = r(n.check, q, 4, 0)), O = 0, A = 0, n.mode = 4;case 4:
              for (; A < 16;) {
                if (0 === j) break e;j--, O += I[k++] << A, A += 8;
              }n.head && (n.head.xflags = 255 & O, n.head.os = O >> 8), 512 & n.flags && (q[0] = 255 & O, q[1] = O >>> 8 & 255, n.check = r(n.check, q, 2, 0)), O = 0, A = 0, n.mode = 5;case 5:
              if (1024 & n.flags) {
                for (; A < 16;) {
                  if (0 === j) break e;j--, O += I[k++] << A, A += 8;
                }n.length = O, n.head && (n.head.extra_len = O), 512 & n.flags && (q[0] = 255 & O, q[1] = O >>> 8 & 255, n.check = r(n.check, q, 2, 0)), O = 0, A = 0;
              } else n.head && (n.head.extra = null);n.mode = 6;case 6:
              if (1024 & n.flags && (N = n.length, N > j && (N = j), N && (n.head && (M = n.head.extra_len - n.length, n.head.extra || (n.head.extra = new Uint8Array(n.head.extra_len)), n.head.extra.set(I.subarray(k, k + N), M)), 512 & n.flags && (n.check = r(n.check, I, N, k)), j -= N, k += N, n.length -= N), n.length)) break e;n.length = 0, n.mode = 7;case 7:
              if (2048 & n.flags) {
                if (0 === j) break e;N = 0;do {
                  M = I[k + N++], n.head && M && n.length < 65536 && (n.head.name += String.fromCharCode(M));
                } while (M && N < j);if (512 & n.flags && (n.check = r(n.check, I, N, k)), j -= N, k += N, M) break e;
              } else n.head && (n.head.name = null);n.length = 0, n.mode = 8;case 8:
              if (4096 & n.flags) {
                if (0 === j) break e;N = 0;do {
                  M = I[k + N++], n.head && M && n.length < 65536 && (n.head.comment += String.fromCharCode(M));
                } while (M && N < j);if (512 & n.flags && (n.check = r(n.check, I, N, k)), j -= N, k += N, M) break e;
              } else n.head && (n.head.comment = null);n.mode = 9;case 9:
              if (512 & n.flags) {
                for (; A < 16;) {
                  if (0 === j) break e;j--, O += I[k++] << A, A += 8;
                }if (O !== (65535 & n.check)) {
                  e.msg = "header crc mismatch", n.mode = w;break;
                }O = 0, A = 0;
              }n.head && (n.head.hcrc = n.flags >> 9 & 1, n.head.done = !0), e.adler = n.check = 0, n.mode = y;break;case 10:
              for (; A < 32;) {
                if (0 === j) break e;j--, O += I[k++] << A, A += 8;
              }e.adler = n.check = _(O), O = 0, A = 0, n.mode = 11;case 11:
              if (0 === n.havedict) return e.next_out = x, e.avail_out = E, e.next_in = k, e.avail_in = j, n.hold = O, n.bits = A, h;e.adler = n.check = 1, n.mode = y;case y:
              if (t === l || t === c) break e;case 13:
              if (n.last) {
                O >>>= 7 & A, A -= 7 & A, n.mode = 27;break;
              }for (; A < 3;) {
                if (0 === j) break e;j--, O += I[k++] << A, A += 8;
              }switch (n.last = 1 & O, O >>>= 1, A -= 1, 3 & O) {case 0:
                  n.mode = 14;break;case 1:
                  if (R(n), n.mode = 20, t === c) {
                    O >>>= 2, A -= 2;break e;
                  }break;case 2:
                  n.mode = 17;break;case 3:
                  e.msg = "invalid block type", n.mode = w;}O >>>= 2, A -= 2;break;case 14:
              for (O >>>= 7 & A, A -= 7 & A; A < 32;) {
                if (0 === j) break e;j--, O += I[k++] << A, A += 8;
              }if ((65535 & O) != (O >>> 16 ^ 65535)) {
                e.msg = "invalid stored block lengths", n.mode = w;break;
              }if (n.length = 65535 & O, O = 0, A = 0, n.mode = 15, t === c) break e;case 15:
              n.mode = 16;case 16:
              if (N = n.length, N) {
                if (N > j && (N = j), N > E && (N = E), 0 === N) break e;v.set(I.subarray(k, k + N), x), j -= N, k += N, E -= N, x += N, n.length -= N;break;
              }n.mode = y;break;case 17:
              for (; A < 14;) {
                if (0 === j) break e;j--, O += I[k++] << A, A += 8;
              }if (n.nlen = 257 + (31 & O), O >>>= 5, A -= 5, n.ndist = 1 + (31 & O), O >>>= 5, A -= 5, n.ncode = 4 + (15 & O), O >>>= 4, A -= 4, n.nlen > 286 || n.ndist > 30) {
                e.msg = "too many length or distance symbols", n.mode = w;break;
              }n.have = 0, n.mode = 18;case 18:
              for (; n.have < n.ncode;) {
                for (; A < 3;) {
                  if (0 === j) break e;j--, O += I[k++] << A, A += 8;
                }n.lens[K[n.have++]] = 7 & O, O >>>= 3, A -= 3;
              }for (; n.have < 19;) {
                n.lens[K[n.have++]] = 0;
              }if (n.lencode = n.lendyn, n.lenbits = 7, Z = { bits: n.lenbits }, P = a(0, n.lens, 0, 19, n.lencode, 0, n.work, Z), n.lenbits = Z.bits, P) {
                e.msg = "invalid code lengths set", n.mode = w;break;
              }n.have = 0, n.mode = 19;case 19:
              for (; n.have < n.nlen + n.ndist;) {
                for (; F = n.lencode[O & (1 << n.lenbits) - 1], L = F >>> 24, B = F >>> 16 & 255, z = 65535 & F, !(L <= A);) {
                  if (0 === j) break e;j--, O += I[k++] << A, A += 8;
                }if (z < 16) O >>>= L, A -= L, n.lens[n.have++] = z;else {
                  if (16 === z) {
                    for (G = L + 2; A < G;) {
                      if (0 === j) break e;j--, O += I[k++] << A, A += 8;
                    }if (O >>>= L, A -= L, 0 === n.have) {
                      e.msg = "invalid bit length repeat", n.mode = w;break;
                    }M = n.lens[n.have - 1], N = 3 + (3 & O), O >>>= 2, A -= 2;
                  } else if (17 === z) {
                    for (G = L + 3; A < G;) {
                      if (0 === j) break e;j--, O += I[k++] << A, A += 8;
                    }O >>>= L, A -= L, M = 0, N = 3 + (7 & O), O >>>= 3, A -= 3;
                  } else {
                    for (G = L + 7; A < G;) {
                      if (0 === j) break e;j--, O += I[k++] << A, A += 8;
                    }O >>>= L, A -= L, M = 0, N = 11 + (127 & O), O >>>= 7, A -= 7;
                  }if (n.have + N > n.nlen + n.ndist) {
                    e.msg = "invalid bit length repeat", n.mode = w;break;
                  }for (; N--;) {
                    n.lens[n.have++] = M;
                  }
                }
              }if (n.mode === w) break;if (0 === n.lens[256]) {
                e.msg = "invalid code -- missing end-of-block", n.mode = w;break;
              }if (n.lenbits = 9, Z = { bits: n.lenbits }, P = a(1, n.lens, 0, n.nlen, n.lencode, 0, n.work, Z), n.lenbits = Z.bits, P) {
                e.msg = "invalid literal/lengths set", n.mode = w;break;
              }if (n.distbits = 6, n.distcode = n.distdyn, Z = { bits: n.distbits }, P = a(2, n.lens, n.nlen, n.ndist, n.distcode, 0, n.work, Z), n.distbits = Z.bits, P) {
                e.msg = "invalid distances set", n.mode = w;break;
              }if (n.mode = 20, t === c) break e;case 20:
              n.mode = 21;case 21:
              if (j >= 6 && E >= 258) {
                e.next_out = x, e.avail_out = E, e.next_in = k, e.avail_in = j, n.hold = O, n.bits = A, o(e, S), x = e.next_out, v = e.output, E = e.avail_out, k = e.next_in, I = e.input, j = e.avail_in, O = n.hold, A = n.bits, n.mode === y && (n.back = -1);break;
              }for (n.back = 0; F = n.lencode[O & (1 << n.lenbits) - 1], L = F >>> 24, B = F >>> 16 & 255, z = 65535 & F, !(L <= A);) {
                if (0 === j) break e;j--, O += I[k++] << A, A += 8;
              }if (B && 0 == (240 & B)) {
                for (D = L, H = B, $ = z; F = n.lencode[$ + ((O & (1 << D + H) - 1) >> D)], L = F >>> 24, B = F >>> 16 & 255, z = 65535 & F, !(D + L <= A);) {
                  if (0 === j) break e;j--, O += I[k++] << A, A += 8;
                }O >>>= D, A -= D, n.back += D;
              }if (O >>>= L, A -= L, n.back += L, n.length = z, 0 === B) {
                n.mode = 26;break;
              }if (32 & B) {
                n.back = -1, n.mode = y;break;
              }if (64 & B) {
                e.msg = "invalid literal/length code", n.mode = w;break;
              }n.extra = 15 & B, n.mode = 22;case 22:
              if (n.extra) {
                for (G = n.extra; A < G;) {
                  if (0 === j) break e;j--, O += I[k++] << A, A += 8;
                }n.length += O & (1 << n.extra) - 1, O >>>= n.extra, A -= n.extra, n.back += n.extra;
              }n.was = n.length, n.mode = 23;case 23:
              for (; F = n.distcode[O & (1 << n.distbits) - 1], L = F >>> 24, B = F >>> 16 & 255, z = 65535 & F, !(L <= A);) {
                if (0 === j) break e;j--, O += I[k++] << A, A += 8;
              }if (0 == (240 & B)) {
                for (D = L, H = B, $ = z; F = n.distcode[$ + ((O & (1 << D + H) - 1) >> D)], L = F >>> 24, B = F >>> 16 & 255, z = 65535 & F, !(D + L <= A);) {
                  if (0 === j) break e;j--, O += I[k++] << A, A += 8;
                }O >>>= D, A -= D, n.back += D;
              }if (O >>>= L, A -= L, n.back += L, 64 & B) {
                e.msg = "invalid distance code", n.mode = w;break;
              }n.offset = z, n.extra = 15 & B, n.mode = 24;case 24:
              if (n.extra) {
                for (G = n.extra; A < G;) {
                  if (0 === j) break e;j--, O += I[k++] << A, A += 8;
                }n.offset += O & (1 << n.extra) - 1, O >>>= n.extra, A -= n.extra, n.back += n.extra;
              }if (n.offset > n.dmax) {
                e.msg = "invalid distance too far back", n.mode = w;break;
              }n.mode = 25;case 25:
              if (0 === E) break e;if (N = S - E, n.offset > N) {
                if (N = n.offset - N, N > n.whave && n.sane) {
                  e.msg = "invalid distance too far back", n.mode = w;break;
                }N > n.wnext ? (N -= n.wnext, T = n.wsize - N) : T = n.wnext - N, N > n.length && (N = n.length), U = n.window;
              } else U = v, T = x - n.offset, N = n.length;N > E && (N = E), E -= N, n.length -= N;do {
                v[x++] = U[T++];
              } while (--N);0 === n.length && (n.mode = 21);break;case 26:
              if (0 === E) break e;v[x++] = n.length, E--, n.mode = 21;break;case 27:
              if (n.wrap) {
                for (; A < 32;) {
                  if (0 === j) break e;j--, O |= I[k++] << A, A += 8;
                }if (S -= E, e.total_out += S, n.total += S, S && (e.adler = n.check = n.flags ? r(n.check, v, S, x - S) : s(n.check, v, S, x - S)), S = E, (n.flags ? O : _(O)) !== n.check) {
                  e.msg = "incorrect data check", n.mode = w;break;
                }O = 0, A = 0;
              }n.mode = 28;case 28:
              if (n.wrap && n.flags) {
                for (; A < 32;) {
                  if (0 === j) break e;j--, O += I[k++] << A, A += 8;
                }if (O !== (4294967295 & n.total)) {
                  e.msg = "incorrect length check", n.mode = w;break;
                }O = 0, A = 0;
              }n.mode = 29;case 29:
              P = u;break e;case w:
              P = p;break e;case 31:
              return b;default:
              return f;}
        }return e.next_out = x, e.avail_out = E, e.next_in = k, e.avail_in = j, n.hold = O, n.bits = A, (n.wsize || S !== e.avail_out && n.mode < w && (n.mode < 27 || t !== i)) && C(e, e.output, e.next_out, S - e.avail_out) ? (n.mode = 31, b) : (V -= e.avail_in, S -= e.avail_out, e.total_in += V, e.total_out += S, n.total += S, n.wrap && S && (e.adler = n.check = n.flags ? r(n.check, v, S, e.next_out - S) : s(n.check, v, S, e.next_out - S)), e.data_type = n.bits + (n.last ? 64 : 0) + (n.mode === y ? 128 : 0) + (20 === n.mode || 15 === n.mode ? 256 : 0), (0 === V && 0 === S || t === i) && P === d && (P = g), P);
      }, e.exports.inflateEnd = function (e) {
        if (!e || !e.state) return f;var t = e.state;return t.window && (t.window = null), e.state = null, d;
      }, e.exports.inflateGetHeader = function (e, t) {
        if (!e || !e.state) return f;var n = e.state;return 0 == (2 & n.wrap) ? f : (n.head = t, t.done = !1, d);
      }, e.exports.inflateSetDictionary = function (e, t) {
        var n = t.length;var r = void 0,
            o = void 0,
            a = void 0;return e && e.state ? (r = e.state, 0 !== r.wrap && 11 !== r.mode ? f : 11 === r.mode && (o = 1, o = s(o, t, n, 0), o !== r.check) ? p : (a = C(e, t, n, n), a ? (r.mode = 31, b) : (r.havedict = 1, d))) : f;
      }, e.exports.inflateInfo = "pako inflate (from Nodeca project)";
    }, "./node_modules/pako/lib/zlib/inftrees.js":
    /*!************************************************!*\
      !*** ./node_modules/pako/lib/zlib/inftrees.js ***!
      \************************************************/function node_modulesPakoLibZlibInftreesJs(e) {
      "use strict";
      var t = 15,
          n = new Uint16Array([3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258, 0, 0]),
          s = new Uint8Array([16, 16, 16, 16, 16, 16, 16, 16, 17, 17, 17, 17, 18, 18, 18, 18, 19, 19, 19, 19, 20, 20, 20, 20, 21, 21, 21, 21, 16, 72, 78]),
          r = new Uint16Array([1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577, 0, 0]),
          o = new Uint8Array([16, 16, 16, 16, 17, 17, 18, 18, 19, 19, 20, 20, 21, 21, 22, 22, 23, 23, 24, 24, 25, 25, 26, 26, 27, 27, 28, 28, 29, 29, 64, 64]);e.exports = function (e, a, i, l, c, d, u, h) {
        var f = h.bits;var p = void 0,
            b = void 0,
            g = void 0,
            m = void 0,
            y = void 0,
            w = void 0,
            _ = 0,
            I = 0,
            v = 0,
            k = 0,
            x = 0,
            j = 0,
            E = 0,
            O = 0,
            A = 0,
            R = 0,
            C = null,
            V = 0;var S = new Uint16Array(16),
            N = new Uint16Array(16);var T = void 0,
            U = void 0,
            L = void 0,
            B = null,
            z = 0;for (_ = 0; _ <= t; _++) {
          S[_] = 0;
        }for (I = 0; I < l; I++) {
          S[a[i + I]]++;
        }for (x = f, k = t; k >= 1 && 0 === S[k]; k--) {}if (x > k && (x = k), 0 === k) return c[d++] = 20971520, c[d++] = 20971520, h.bits = 1, 0;for (v = 1; v < k && 0 === S[v]; v++) {}for (x < v && (x = v), O = 1, _ = 1; _ <= t; _++) {
          if (O <<= 1, O -= S[_], O < 0) return -1;
        }if (O > 0 && (0 === e || 1 !== k)) return -1;for (N[1] = 0, _ = 1; _ < t; _++) {
          N[_ + 1] = N[_] + S[_];
        }for (I = 0; I < l; I++) {
          0 !== a[i + I] && (u[N[a[i + I]]++] = I);
        }if (0 === e ? (C = B = u, w = 19) : 1 === e ? (C = n, V -= 257, B = s, z -= 257, w = 256) : (C = r, B = o, w = -1), R = 0, I = 0, _ = v, y = d, j = x, E = 0, g = -1, A = 1 << x, m = A - 1, 1 === e && A > 852 || 2 === e && A > 592) return 1;for (;;) {
          T = _ - E, u[I] < w ? (U = 0, L = u[I]) : u[I] > w ? (U = B[z + u[I]], L = C[V + u[I]]) : (U = 96, L = 0), p = 1 << _ - E, b = 1 << j, v = b;do {
            b -= p, c[y + (R >> E) + b] = T << 24 | U << 16 | L | 0;
          } while (0 !== b);for (p = 1 << _ - 1; R & p;) {
            p >>= 1;
          }if (0 !== p ? (R &= p - 1, R += p) : R = 0, I++, 0 == --S[_]) {
            if (_ === k) break;_ = a[i + u[I]];
          }if (_ > x && (R & m) !== g) {
            for (0 === E && (E = x), y += v, j = _ - E, O = 1 << j; j + E < k && (O -= S[j + E], !(O <= 0));) {
              j++, O <<= 1;
            }if (A += 1 << j, 1 === e && A > 852 || 2 === e && A > 592) return 1;g = R & m, c[g] = x << 24 | j << 16 | y - d | 0;
          }
        }return 0 !== R && (c[y + R] = _ - E << 24 | 64 << 16 | 0), h.bits = x, 0;
      };
    }, "./node_modules/pako/lib/zlib/messages.js":
    /*!************************************************!*\
      !*** ./node_modules/pako/lib/zlib/messages.js ***!
      \************************************************/function node_modulesPakoLibZlibMessagesJs(e) {
      "use strict";
      e.exports = { 2: "need dictionary", 1: "stream end", 0: "", "-1": "file error", "-2": "stream error", "-3": "data error", "-4": "insufficient memory", "-5": "buffer error", "-6": "incompatible version" };
    }, "./node_modules/pako/lib/zlib/trees.js":
    /*!*********************************************!*\
      !*** ./node_modules/pako/lib/zlib/trees.js ***!
      \*********************************************/function node_modulesPakoLibZlibTreesJs(e) {
      "use strict";
      function t(e) {
        var t = e.length;for (; --t >= 0;) {
          e[t] = 0;
        }
      }var n = 256,
          s = 286,
          r = 30,
          o = 15,
          a = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]),
          i = new Uint8Array([0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]),
          l = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 3, 7]),
          c = new Uint8Array([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]),
          d = new Array(576);t(d);var u = new Array(60);t(u);var h = new Array(512);t(h);var f = new Array(256);t(f);var p = new Array(29);t(p);var b = new Array(r);function g(e, t, n, s, r) {
        this.static_tree = e, this.extra_bits = t, this.extra_base = n, this.elems = s, this.max_length = r, this.has_stree = e && e.length;
      }var m = void 0,
          y = void 0,
          w = void 0;function _(e, t) {
        this.dyn_tree = e, this.max_code = 0, this.stat_desc = t;
      }t(b);var I = function I(e) {
        return e < 256 ? h[e] : h[256 + (e >>> 7)];
      },
          v = function v(e, t) {
        e.pending_buf[e.pending++] = 255 & t, e.pending_buf[e.pending++] = t >>> 8 & 255;
      },
          k = function k(e, t, n) {
        e.bi_valid > 16 - n ? (e.bi_buf |= t << e.bi_valid & 65535, v(e, e.bi_buf), e.bi_buf = t >> 16 - e.bi_valid, e.bi_valid += n - 16) : (e.bi_buf |= t << e.bi_valid & 65535, e.bi_valid += n);
      },
          x = function x(e, t, n) {
        k(e, n[2 * t], n[2 * t + 1]);
      },
          j = function j(e, t) {
        var n = 0;do {
          n |= 1 & e, e >>>= 1, n <<= 1;
        } while (--t > 0);return n >>> 1;
      },
          E = function E(e, t, n) {
        var s = new Array(16);var r = void 0,
            a = void 0,
            i = 0;for (r = 1; r <= o; r++) {
          s[r] = i = i + n[r - 1] << 1;
        }for (a = 0; a <= t; a++) {
          var _t98 = e[2 * a + 1];0 !== _t98 && (e[2 * a] = j(s[_t98]++, _t98));
        }
      },
          O = function O(e) {
        var t = void 0;for (t = 0; t < s; t++) {
          e.dyn_ltree[2 * t] = 0;
        }for (t = 0; t < r; t++) {
          e.dyn_dtree[2 * t] = 0;
        }for (t = 0; t < 19; t++) {
          e.bl_tree[2 * t] = 0;
        }e.dyn_ltree[512] = 1, e.opt_len = e.static_len = 0, e.last_lit = e.matches = 0;
      },
          A = function A(e) {
        e.bi_valid > 8 ? v(e, e.bi_buf) : e.bi_valid > 0 && (e.pending_buf[e.pending++] = e.bi_buf), e.bi_buf = 0, e.bi_valid = 0;
      },
          R = function R(e, t, n, s) {
        var r = 2 * t,
            o = 2 * n;return e[r] < e[o] || e[r] === e[o] && s[t] <= s[n];
      },
          C = function C(e, t, n) {
        var s = e.heap[n];var r = n << 1;for (; r <= e.heap_len && (r < e.heap_len && R(t, e.heap[r + 1], e.heap[r], e.depth) && r++, !R(t, s, e.heap[r], e.depth));) {
          e.heap[n] = e.heap[r], n = r, r <<= 1;
        }e.heap[n] = s;
      },
          V = function V(e, t, s) {
        var r = void 0,
            o = void 0,
            l = void 0,
            c = void 0,
            d = 0;if (0 !== e.last_lit) do {
          r = e.pending_buf[e.d_buf + 2 * d] << 8 | e.pending_buf[e.d_buf + 2 * d + 1], o = e.pending_buf[e.l_buf + d], d++, 0 === r ? x(e, o, t) : (l = f[o], x(e, l + n + 1, t), c = a[l], 0 !== c && (o -= p[l], k(e, o, c)), r--, l = I(r), x(e, l, s), c = i[l], 0 !== c && (r -= b[l], k(e, r, c)));
        } while (d < e.last_lit);x(e, 256, t);
      },
          S = function S(e, t) {
        var n = t.dyn_tree,
            s = t.stat_desc.static_tree,
            r = t.stat_desc.has_stree,
            a = t.stat_desc.elems;var i = void 0,
            l = void 0,
            c = void 0,
            d = -1;for (e.heap_len = 0, e.heap_max = 573, i = 0; i < a; i++) {
          0 !== n[2 * i] ? (e.heap[++e.heap_len] = d = i, e.depth[i] = 0) : n[2 * i + 1] = 0;
        }for (; e.heap_len < 2;) {
          c = e.heap[++e.heap_len] = d < 2 ? ++d : 0, n[2 * c] = 1, e.depth[c] = 0, e.opt_len--, r && (e.static_len -= s[2 * c + 1]);
        }for (t.max_code = d, i = e.heap_len >> 1; i >= 1; i--) {
          C(e, n, i);
        }c = a;do {
          i = e.heap[1], e.heap[1] = e.heap[e.heap_len--], C(e, n, 1), l = e.heap[1], e.heap[--e.heap_max] = i, e.heap[--e.heap_max] = l, n[2 * c] = n[2 * i] + n[2 * l], e.depth[c] = (e.depth[i] >= e.depth[l] ? e.depth[i] : e.depth[l]) + 1, n[2 * i + 1] = n[2 * l + 1] = c, e.heap[1] = c++, C(e, n, 1);
        } while (e.heap_len >= 2);e.heap[--e.heap_max] = e.heap[1], function (e, t) {
          var n = t.dyn_tree,
              s = t.max_code,
              r = t.stat_desc.static_tree,
              a = t.stat_desc.has_stree,
              i = t.stat_desc.extra_bits,
              l = t.stat_desc.extra_base,
              c = t.stat_desc.max_length;var d = void 0,
              u = void 0,
              h = void 0,
              f = void 0,
              p = void 0,
              b = void 0,
              g = 0;for (f = 0; f <= o; f++) {
            e.bl_count[f] = 0;
          }for (n[2 * e.heap[e.heap_max] + 1] = 0, d = e.heap_max + 1; d < 573; d++) {
            u = e.heap[d], f = n[2 * n[2 * u + 1] + 1] + 1, f > c && (f = c, g++), n[2 * u + 1] = f, u > s || (e.bl_count[f]++, p = 0, u >= l && (p = i[u - l]), b = n[2 * u], e.opt_len += b * (f + p), a && (e.static_len += b * (r[2 * u + 1] + p)));
          }if (0 !== g) {
            do {
              for (f = c - 1; 0 === e.bl_count[f];) {
                f--;
              }e.bl_count[f]--, e.bl_count[f + 1] += 2, e.bl_count[c]--, g -= 2;
            } while (g > 0);for (f = c; 0 !== f; f--) {
              for (u = e.bl_count[f]; 0 !== u;) {
                h = e.heap[--d], h > s || (n[2 * h + 1] !== f && (e.opt_len += (f - n[2 * h + 1]) * n[2 * h], n[2 * h + 1] = f), u--);
              }
            }
          }
        }(e, t), E(n, d, e.bl_count);
      },
          N = function N(e, t, n) {
        var s = void 0,
            r = void 0,
            o = -1,
            a = t[1],
            i = 0,
            l = 7,
            c = 4;for (0 === a && (l = 138, c = 3), t[2 * (n + 1) + 1] = 65535, s = 0; s <= n; s++) {
          r = a, a = t[2 * (s + 1) + 1], ++i < l && r === a || (i < c ? e.bl_tree[2 * r] += i : 0 !== r ? (r !== o && e.bl_tree[2 * r]++, e.bl_tree[32]++) : i <= 10 ? e.bl_tree[34]++ : e.bl_tree[36]++, i = 0, o = r, 0 === a ? (l = 138, c = 3) : r === a ? (l = 6, c = 3) : (l = 7, c = 4));
        }
      },
          T = function T(e, t, n) {
        var s = void 0,
            r = void 0,
            o = -1,
            a = t[1],
            i = 0,
            l = 7,
            c = 4;for (0 === a && (l = 138, c = 3), s = 0; s <= n; s++) {
          if (r = a, a = t[2 * (s + 1) + 1], !(++i < l && r === a)) {
            if (i < c) do {
              x(e, r, e.bl_tree);
            } while (0 != --i);else 0 !== r ? (r !== o && (x(e, r, e.bl_tree), i--), x(e, 16, e.bl_tree), k(e, i - 3, 2)) : i <= 10 ? (x(e, 17, e.bl_tree), k(e, i - 3, 3)) : (x(e, 18, e.bl_tree), k(e, i - 11, 7));i = 0, o = r, 0 === a ? (l = 138, c = 3) : r === a ? (l = 6, c = 3) : (l = 7, c = 4);
          }
        }
      };var U = !1;var L = function L(e, t, n, s) {
        k(e, 0 + (s ? 1 : 0), 3), function (e, t, n, s) {
          A(e), s && (v(e, n), v(e, ~n)), e.pending_buf.set(e.window.subarray(t, t + n), e.pending), e.pending += n;
        }(e, t, n, !0);
      };e.exports._tr_init = function (e) {
        U || (function () {
          var e = void 0,
              t = void 0,
              n = void 0,
              c = void 0,
              _ = void 0;var I = new Array(16);for (n = 0, c = 0; c < 28; c++) {
            for (p[c] = n, e = 0; e < 1 << a[c]; e++) {
              f[n++] = c;
            }
          }for (f[n - 1] = c, _ = 0, c = 0; c < 16; c++) {
            for (b[c] = _, e = 0; e < 1 << i[c]; e++) {
              h[_++] = c;
            }
          }for (_ >>= 7; c < r; c++) {
            for (b[c] = _ << 7, e = 0; e < 1 << i[c] - 7; e++) {
              h[256 + _++] = c;
            }
          }for (t = 0; t <= o; t++) {
            I[t] = 0;
          }for (e = 0; e <= 143;) {
            d[2 * e + 1] = 8, e++, I[8]++;
          }for (; e <= 255;) {
            d[2 * e + 1] = 9, e++, I[9]++;
          }for (; e <= 279;) {
            d[2 * e + 1] = 7, e++, I[7]++;
          }for (; e <= 287;) {
            d[2 * e + 1] = 8, e++, I[8]++;
          }for (E(d, 287, I), e = 0; e < r; e++) {
            u[2 * e + 1] = 5, u[2 * e] = j(e, 5);
          }m = new g(d, a, 257, s, o), y = new g(u, i, 0, r, o), w = new g(new Array(0), l, 0, 19, 7);
        }(), U = !0), e.l_desc = new _(e.dyn_ltree, m), e.d_desc = new _(e.dyn_dtree, y), e.bl_desc = new _(e.bl_tree, w), e.bi_buf = 0, e.bi_valid = 0, O(e);
      }, e.exports._tr_stored_block = L, e.exports._tr_flush_block = function (e, t, s, r) {
        var o = void 0,
            a = void 0,
            i = 0;e.level > 0 ? (2 === e.strm.data_type && (e.strm.data_type = function (e) {
          var t = void 0,
              s = 4093624447;for (t = 0; t <= 31; t++, s >>>= 1) {
            if (1 & s && 0 !== e.dyn_ltree[2 * t]) return 0;
          }if (0 !== e.dyn_ltree[18] || 0 !== e.dyn_ltree[20] || 0 !== e.dyn_ltree[26]) return 1;for (t = 32; t < n; t++) {
            if (0 !== e.dyn_ltree[2 * t]) return 1;
          }return 0;
        }(e)), S(e, e.l_desc), S(e, e.d_desc), i = function (e) {
          var t = void 0;for (N(e, e.dyn_ltree, e.l_desc.max_code), N(e, e.dyn_dtree, e.d_desc.max_code), S(e, e.bl_desc), t = 18; t >= 3 && 0 === e.bl_tree[2 * c[t] + 1]; t--) {}return e.opt_len += 3 * (t + 1) + 5 + 5 + 4, t;
        }(e), o = e.opt_len + 3 + 7 >>> 3, a = e.static_len + 3 + 7 >>> 3, a <= o && (o = a)) : o = a = s + 5, s + 4 <= o && -1 !== t ? L(e, t, s, r) : 4 === e.strategy || a === o ? (k(e, 2 + (r ? 1 : 0), 3), V(e, d, u)) : (k(e, 4 + (r ? 1 : 0), 3), function (e, t, n, s) {
          var r = void 0;for (k(e, t - 257, 5), k(e, n - 1, 5), k(e, s - 4, 4), r = 0; r < s; r++) {
            k(e, e.bl_tree[2 * c[r] + 1], 3);
          }T(e, e.dyn_ltree, t - 1), T(e, e.dyn_dtree, n - 1);
        }(e, e.l_desc.max_code + 1, e.d_desc.max_code + 1, i + 1), V(e, e.dyn_ltree, e.dyn_dtree)), O(e), r && A(e);
      }, e.exports._tr_tally = function (e, t, s) {
        return e.pending_buf[e.d_buf + 2 * e.last_lit] = t >>> 8 & 255, e.pending_buf[e.d_buf + 2 * e.last_lit + 1] = 255 & t, e.pending_buf[e.l_buf + e.last_lit] = 255 & s, e.last_lit++, 0 === t ? e.dyn_ltree[2 * s]++ : (e.matches++, t--, e.dyn_ltree[2 * (f[s] + n + 1)]++, e.dyn_dtree[2 * I(t)]++), e.last_lit === e.lit_bufsize - 1;
      }, e.exports._tr_align = function (e) {
        k(e, 2, 3), x(e, 256, d), function (e) {
          16 === e.bi_valid ? (v(e, e.bi_buf), e.bi_buf = 0, e.bi_valid = 0) : e.bi_valid >= 8 && (e.pending_buf[e.pending++] = 255 & e.bi_buf, e.bi_buf >>= 8, e.bi_valid -= 8);
        }(e);
      };
    }, "./node_modules/pako/lib/zlib/zstream.js":
    /*!***********************************************!*\
      !*** ./node_modules/pako/lib/zlib/zstream.js ***!
      \***********************************************/function node_modulesPakoLibZlibZstreamJs(e) {
      "use strict";
      e.exports = function () {
        this.input = null, this.next_in = 0, this.avail_in = 0, this.total_in = 0, this.output = null, this.next_out = 0, this.avail_out = 0, this.total_out = 0, this.msg = "", this.state = null, this.data_type = 2, this.adler = 0;
      };
    }, "./node_modules/uuid/index.js":
    /*!************************************!*\
      !*** ./node_modules/uuid/index.js ***!
      \************************************/function node_modulesUuidIndexJs(e, t, n) {
      var s = n( /*! ./v1 */"./node_modules/uuid/v1.js"),
          r = n( /*! ./v4 */"./node_modules/uuid/v4.js"),
          o = r;o.v1 = s, o.v4 = r, e.exports = o;
    }, "./node_modules/uuid/lib/bytesToUuid.js":
    /*!**********************************************!*\
      !*** ./node_modules/uuid/lib/bytesToUuid.js ***!
      \**********************************************/function node_modulesUuidLibBytesToUuidJs(e) {
      for (var t = [], n = 0; n < 256; ++n) {
        t[n] = (n + 256).toString(16).substr(1);
      }e.exports = function (e, n) {
        var s = n || 0,
            r = t;return [r[e[s++]], r[e[s++]], r[e[s++]], r[e[s++]], "-", r[e[s++]], r[e[s++]], "-", r[e[s++]], r[e[s++]], "-", r[e[s++]], r[e[s++]], "-", r[e[s++]], r[e[s++]], r[e[s++]], r[e[s++]], r[e[s++]], r[e[s++]]].join("");
      };
    }, "./node_modules/uuid/lib/rng-browser.js":
    /*!**********************************************!*\
      !*** ./node_modules/uuid/lib/rng-browser.js ***!
      \**********************************************/function node_modulesUuidLibRngBrowserJs(e) {
      var t = "undefined" != typeof crypto && crypto.getRandomValues && crypto.getRandomValues.bind(crypto) || "undefined" != typeof msCrypto && "function" == typeof window.msCrypto.getRandomValues && msCrypto.getRandomValues.bind(msCrypto);if (t) {
        var n = new Uint8Array(16);e.exports = function () {
          return t(n), n;
        };
      } else {
        var s = new Array(16);e.exports = function () {
          for (var e, t = 0; t < 16; t++) {
            0 == (3 & t) && (e = 4294967296 * Math.random()), s[t] = e >>> ((3 & t) << 3) & 255;
          }return s;
        };
      }
    }, "./node_modules/uuid/v1.js":
    /*!*********************************!*\
      !*** ./node_modules/uuid/v1.js ***!
      \*********************************/function node_modulesUuidV1Js(e, t, n) {
      var s,
          r,
          o = n( /*! ./lib/rng */"./node_modules/uuid/lib/rng-browser.js"),
          a = n( /*! ./lib/bytesToUuid */"./node_modules/uuid/lib/bytesToUuid.js"),
          i = 0,
          l = 0;e.exports = function (e, t, n) {
        var c = t && n || 0,
            d = t || [],
            u = (e = e || {}).node || s,
            h = void 0 !== e.clockseq ? e.clockseq : r;if (null == u || null == h) {
          var f = o();null == u && (u = s = [1 | f[0], f[1], f[2], f[3], f[4], f[5]]), null == h && (h = r = 16383 & (f[6] << 8 | f[7]));
        }var p = void 0 !== e.msecs ? e.msecs : new Date().getTime(),
            b = void 0 !== e.nsecs ? e.nsecs : l + 1,
            g = p - i + (b - l) / 1e4;if (g < 0 && void 0 === e.clockseq && (h = h + 1 & 16383), (g < 0 || p > i) && void 0 === e.nsecs && (b = 0), b >= 1e4) throw new Error("uuid.v1(): Can't create more than 10M uuids/sec");i = p, l = b, r = h;var m = (1e4 * (268435455 & (p += 122192928e5)) + b) % 4294967296;d[c++] = m >>> 24 & 255, d[c++] = m >>> 16 & 255, d[c++] = m >>> 8 & 255, d[c++] = 255 & m;var y = p / 4294967296 * 1e4 & 268435455;d[c++] = y >>> 8 & 255, d[c++] = 255 & y, d[c++] = y >>> 24 & 15 | 16, d[c++] = y >>> 16 & 255, d[c++] = h >>> 8 | 128, d[c++] = 255 & h;for (var w = 0; w < 6; ++w) {
          d[c + w] = u[w];
        }return t || a(d);
      };
    }, "./node_modules/uuid/v4.js":
    /*!*********************************!*\
      !*** ./node_modules/uuid/v4.js ***!
      \*********************************/function node_modulesUuidV4Js(e, t, n) {
      var s = n( /*! ./lib/rng */"./node_modules/uuid/lib/rng-browser.js"),
          r = n( /*! ./lib/bytesToUuid */"./node_modules/uuid/lib/bytesToUuid.js");e.exports = function (e, t, n) {
        var o = t && n || 0;"string" == typeof e && (t = "binary" === e ? new Array(16) : null, e = null);var a = (e = e || {}).random || (e.rng || s)();if (a[6] = 15 & a[6] | 64, a[8] = 63 & a[8] | 128, t) for (var i = 0; i < 16; ++i) {
          t[o + i] = a[i];
        }return t || r(a);
      };
    }, "./src/automerge.js":
    /*!**************************!*\
      !*** ./src/automerge.js ***!
      \**************************/function srcAutomergeJs(e, t, n) {
      var s = n( /*! ./uuid */"./src/uuid.js"),
          r = n( /*! ../frontend */"./frontend/index.js"),
          _n118 = n( /*! ../frontend/constants */"./frontend/constants.js"),
          o = _n118.OPTIONS,
          _n119 = n( /*! ../backend/columnar */"./backend/columnar.js"),
          a = _n119.encodeChange,
          i = _n119.decodeChange,
          _n120 = n( /*! ./common */"./src/common.js"),
          l = _n120.isObject;var c = n( /*! ../backend */"./backend/index.js");function d(e) {
        if ("string" == typeof e) e = { actorId: e };else if (void 0 === e) e = {};else if (!l(e)) throw new TypeError("Unsupported options for init(): " + e);return r.init(Object.assign({ backend: c }, e));
      }function u(e, t, n) {
        var _r$change = r.change(e, t, n),
            _r$change2 = _slicedToArray(_r$change, 1),
            s = _r$change2[0];

        return s;
      }function h(e) {
        return c.getAllChanges(r.getBackendState(e, "getAllChanges"));
      }function f(e, t, n, s, a) {
        var i = r.applyPatch(e, t, n),
            l = a.patchCallback || e[o].patchCallback;return l && l(t, e, i, !1, s), i;
      }function p(e, t) {
        var n = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : {};
        var s = r.getBackendState(e, "applyChanges"),
            _c$applyChanges = c.applyChanges(s, t),
            _c$applyChanges2 = _slicedToArray(_c$applyChanges, 2),
            o = _c$applyChanges2[0],
            a = _c$applyChanges2[1];return [f(e, a, o, t, n), a];
      }e.exports = { init: d, from: function from(e, t) {
          return u(d(t), { message: "Initialization" }, function (t) {
            return Object.assign(t, e);
          });
        }, change: u, emptyChange: function emptyChange(e, t) {
          var _r$emptyChange = r.emptyChange(e, t),
              _r$emptyChange2 = _slicedToArray(_r$emptyChange, 1),
              n = _r$emptyChange2[0];

          return n;
        }, clone: function clone(e) {
          var t = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};
          var n = c.clone(r.getBackendState(e, "clone"));return f(d(t), c.getPatch(n), n, [], t);
        }, free: function free(e) {
          c.free(r.getBackendState(e, "free"));
        }, load: function load(e) {
          var t = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};
          var n = c.load(e);return f(d(t), c.getPatch(n), n, [e], t);
        }, save: function save(e) {
          return c.save(r.getBackendState(e, "save"));
        }, merge: function merge(e, t) {
          var n = r.getBackendState(e, "merge"),
              s = r.getBackendState(t, "merge", "second"),
              o = c.getChangesAdded(n, s),
              _p2 = p(e, o),
              _p3 = _slicedToArray(_p2, 1),
              a = _p3[0];return a;
        }, getChanges: function getChanges(e, t) {
          var n = r.getBackendState(e, "getChanges"),
              s = r.getBackendState(t, "getChanges", "second");return c.getChanges(s, c.getHeads(n));
        }, getAllChanges: h, applyChanges: p, encodeChange: a, decodeChange: i, equals: function e(t, n) {
          if (!l(t) || !l(n)) return t === n;var s = Object.keys(t).sort(),
              r = Object.keys(n).sort();if (s.length !== r.length) return !1;for (var _o24 = 0; _o24 < s.length; _o24++) {
            if (s[_o24] !== r[_o24]) return !1;if (!e(t[s[_o24]], n[r[_o24]])) return !1;
          }return !0;
        }, getHistory: function getHistory(e) {
          var t = r.getActorId(e),
              n = h(e);return n.map(function (e, s) {
            return { get change() {
                return i(e);
              }, get snapshot() {
                var e = c.loadChanges(c.init(), n.slice(0, s + 1));return r.applyPatch(d(t), c.getPatch(e), e);
              } };
          });
        }, uuid: s, Frontend: r, setDefaultBackend: function setDefaultBackend(e) {
          c = e;
        }, generateSyncMessage: function generateSyncMessage(e, t) {
          var n = r.getBackendState(e, "generateSyncMessage");return c.generateSyncMessage(n, t);
        }, receiveSyncMessage: function receiveSyncMessage(e, t, n) {
          var s = r.getBackendState(e, "receiveSyncMessage"),
              _c$receiveSyncMessage = c.receiveSyncMessage(s, t, n),
              _c$receiveSyncMessage2 = _slicedToArray(_c$receiveSyncMessage, 3),
              a = _c$receiveSyncMessage2[0],
              i = _c$receiveSyncMessage2[1],
              l = _c$receiveSyncMessage2[2];if (!l) return [e, i, l];var d = null;return e[o].patchCallback && (d = c.decodeSyncMessage(n).changes), [f(e, l, a, d, {}), i, l];
        }, initSyncState: function initSyncState() {
          return c.initSyncState();
        }, get Backend() {
          return c;
        } };var _arr4 = ["getObjectId", "getObjectById", "getActorId", "setActorId", "getConflicts", "getLastLocalChange", "Text", "Table", "Counter", "Observable", "Int", "Uint", "Float64"];
      for (var _i18 = 0; _i18 < _arr4.length; _i18++) {
        var _t99 = _arr4[_i18];e.exports[_t99] = r[_t99];
      }
    }, "./src/common.js":
    /*!***********************!*\
      !*** ./src/common.js ***!
      \***********************/function srcCommonJs(e) {
      function t(e) {
        return "object" == (typeof e === "undefined" ? "undefined" : _typeof(e)) && null !== e;
      }e.exports = { isObject: t, copyObject: function copyObject(e) {
          if (!t(e)) return {};var n = {};var _iteratorNormalCompletion104 = true;
          var _didIteratorError104 = false;
          var _iteratorError104 = undefined;

          try {
            for (var _iterator104 = Object.keys(e)[Symbol.iterator](), _step104; !(_iteratorNormalCompletion104 = (_step104 = _iterator104.next()).done); _iteratorNormalCompletion104 = true) {
              var _t100 = _step104.value;
              n[_t100] = e[_t100];
            }
          } catch (err) {
            _didIteratorError104 = true;
            _iteratorError104 = err;
          } finally {
            try {
              if (!_iteratorNormalCompletion104 && _iterator104.return) {
                _iterator104.return();
              }
            } finally {
              if (_didIteratorError104) {
                throw _iteratorError104;
              }
            }
          }

          return n;
        }, parseOpId: function parseOpId(e) {
          var t = /^(\d+)@(.*)$/.exec(e || "");if (!t) throw new RangeError("Not a valid opId: " + e);return { counter: parseInt(t[1], 10), actorId: t[2] };
        }, equalBytes: function equalBytes(e, t) {
          if (!(e instanceof Uint8Array && t instanceof Uint8Array)) throw new TypeError("equalBytes can only compare Uint8Arrays");if (e.byteLength !== t.byteLength) return !1;for (var _n121 = 0; _n121 < e.byteLength; _n121++) {
            if (e[_n121] !== t[_n121]) return !1;
          }return !0;
        }, createArrayOfNulls: function createArrayOfNulls(e) {
          var t = new Array(e);for (var _n122 = 0; _n122 < e; _n122++) {
            t[_n122] = null;
          }return t;
        } };
    }, "./src/uuid.js":
    /*!*********************!*\
      !*** ./src/uuid.js ***!
      \*********************/function srcUuidJs(e, t, n) {
      var _n123 = n( /*! uuid */"./node_modules/uuid/index.js"),
          s = _n123.v4;

      function r() {
        return s().replace(/-/g, "");
      }var o = r;function a() {
        return o();
      }a.setFactory = function (e) {
        o = e;
      }, a.reset = function () {
        o = r;
      }, e.exports = a;
    } }, t = {}, n = function n(s) {
    if (t[s]) return t[s].exports;var r = t[s] = { exports: {} };return e[s].call(r.exports, r, r.exports, n), r.exports;
  }("./src/automerge.js"), n;var e, t, n;
});