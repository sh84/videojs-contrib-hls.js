'use strict';

var Hls = require('hls.js');

/**
 * hls.js source handler
 * @param source
 * @param tech
 * @constructor
 */
function Html5HlsJS(source, tech) {
  var options = tech.options_;
  var player = this.player = videojs(options.playerId);
  var el = tech.el();
  var is_live = false;
  var hls = this.player.hls_ = new Hls(options.hlsjsConfig);
  var errors_count = 0;
  var last_error_time = null;

  function videoError() {
    hls.destroy();
    player.error({
      code: 4, 
      message: Array.prototype.slice.call(arguments).reduce(function(err, cur) {
        return err + player.localize(cur);
      }, '')
    });
  }

  /**
   * creates an error handler function
   * @returns {Function}
   */
  function errorHandlerFactory() {
    var _recoverDecodingErrorDate = null;
    var _recoverAudioCodecErrorDate = null;

    return function() {
      var now = Date.now();

      if (!_recoverDecodingErrorDate || now - _recoverDecodingErrorDate > 2000) {
        _recoverDecodingErrorDate = now;
        hls.recoverMediaError();
      } else if (!_recoverAudioCodecErrorDate || now - _recoverAudioCodecErrorDate > 2000) {
        _recoverAudioCodecErrorDate = now;
        hls.swapAudioCodec();
        hls.recoverMediaError();
      } else {
        videoError('Error loading media: File could not be played');
      }
    };
  }

  // create separate error handlers for hlsjs and the video tag
  var hlsjsErrorHandler = errorHandlerFactory();
  var videoTagErrorHandler = errorHandlerFactory();

  // listen to error events coming from the video tag
  el.addEventListener('error', function(e) {
    var mediaError = e.currentTarget.error;

    if (mediaError.code === mediaError.MEDIA_ERR_DECODE) {
      videoTagErrorHandler();
    } else {
      videoError('Error loading media: File could not be played');
    }
  });

  /**
   *
   */
  this.dispose = function() {
    hls.destroy();
    this.player.hls = null;
  };

  /**
   * returns the duration of the stream, or Infinity if live video
   * @returns {Infinity|number}
   */
  this.duration = function() {
    return is_live ? Infinity : el.duration || 0;
  };

  // update live status on level load
  hls.on(Hls.Events.LEVEL_LOADED, function(event, data) {
    is_live = data.details.live && data.details.startSN;
  });

  // try to recover on fatal errors
  hls.on(Hls.Events.ERROR, function(event, data) {
    console.log('ERROR', event, data);
    var now = Date.now();
    if (data.fatal) {
      errors_count += 1;
      last_error_time = now;
      switch (data.type) {
        case Hls.ErrorTypes.NETWORK_ERROR:
          hls.startLoad();
          break;
        case Hls.ErrorTypes.MEDIA_ERROR:
          hlsjsErrorHandler();
          break;
        default:
          videoError('Error loading media: File could not be played');
          break;
      }
    } else if (data.type == Hls.ErrorTypes.NETWORK_ERROR) {
      errors_count += 1;
      last_error_time = now;
    }
    if (errors_count >= 5 && last_error_time && now - last_error_time < 30000) {
      return videoError('Too many errors. Last error: ', data.reason || data.type);
    }
  });

  Object.keys(Hls.Events).forEach(function(key) {
    var eventName = Hls.Events[key];
    hls.on(eventName, function(event, data) {
      tech.trigger(eventName, data);
    });
  });

  // Intercept native TextTrack calls and route to video.js directly only
  // if native text tracks are not supported on this browser.
  if (!tech.featuresNativeTextTracks) {
    Object.defineProperty(el, 'textTracks', {
      value: tech.textTracks,
      writable: false
    });
    el.addTextTrack = function() {
      return tech.addTextTrack.apply(tech, arguments);
    };
  }

  // attach hlsjs to videotag
  hls.attachMedia(el);
  hls.loadSource(source.src);
}

var hlsTypeRE = /^application\/(x-mpegURL|vnd\.apple\.mpegURL)$/i;
var hlsExtRE = /\.m3u8/i;

var HlsSourceHandler = {
  canHandleSource: function(source) {
    if (source.skipContribHlsJs) {
      return '';
    } else if (hlsTypeRE.test(source.type)) {
      return 'probably';
    } else if (hlsExtRE.test(source.src)) {
      return 'maybe';
    } else {
      return '';
    }
  },
  handleSource: function(source, tech) {
    return new Html5HlsJS(source, tech);
  },
  canPlayType: function(type) {
    if (hlsTypeRE.test(type)) {
      return 'probably';
    }

    return '';
  }
};

if (Hls.isSupported()) {
  var videojs = require('video.js'); // resolved UMD-wise through webpack

  if (videojs) {
    videojs.getTech('Html5').registerSourceHandler(HlsSourceHandler, 0);
  } else {
    console.warn('videojs-contrib-hls.js: Couldn\'t find find window.videojs nor require(\'video.js\')');
  }
}
