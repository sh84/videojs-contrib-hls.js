'use strict';

var Hls = require('hls.js');

var default_config = {
  fatal_errors_retry_count: 10,
  fatal_errors_timeout: 30,
  fatal_errors_recovery_time: 300,
  first_load_error_retry_time: 1
};

/**
 * hls.js source handler
 * @param source
 * @param tech
 * @constructor
 */
function Html5HlsJS(source, tech) {
  var player = this.player = videojs(tech.options_.playerId);
  var el = tech.el();
  var is_live = false;
  var is_first_loaded = false;
  var config = videojs.mergeOptions(default_config, tech.options_.hlsjsConfig);
  var hls = this.player.hls_ = new Hls(config);
  var fatal_errors_count = 0;
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

  function audioTrackChange() {
    var tracks = tech.audioTracks();
    for (var i=0; i < tracks.length; i++) {
      if (tracks[i].enabled) hls.audioTrack = tracks[i].properties_.id;
    }
  }

  function fullHlsReinit() {
    fatal_errors_count += 1;
    hls.destroy();
    tech.off(tech.el_, 'loadstart', tech.constructor.prototype.successiveLoadStartListener_);
    setTimeout(function() {
      config = videojs.mergeOptions(default_config, tech.options_.hlsjsConfig);
      hls = player.hls_ = new Hls(config);
      errors_count = 0;
      is_first_loaded = false;
      hlsAddEventsListeners();
      hls.attachMedia(el);
      hls.loadSource(source.src);
      player.play(); 
    }, 500);
  }

  function hlsAddEventsListeners() {
    // update live status on level load
    hls.on(Hls.Events.LEVEL_LOADED, function(event, data) {
      is_live = data.details.live && data.details.startSN;
      is_first_loaded = true;
      if (last_error_time && Date.now() - last_error_time > config.fatal_errors_recovery_time * 1000) {
        fatal_errors_count = 0;
        errors_count = 0;
        last_error_time = null;
      }
    });

    // try to recover on fatal errors
    hls.on(Hls.Events.ERROR, function(event, data) {
      console.log('ERROR', event, data);
      var now = Date.now();
      if (data.response && (data.response.code == 403 || data.response.code == 503)) {
        return player.trigger('network_forbidden_error');
      }
      if (fatal_errors_count > config.fatal_errors_retry_count) {
        return videoError('Too many errors. Last error: ', data.reason || data.type);
      }
      if (errors_count >= 5 && last_error_time && now - last_error_time > config.fatal_errors_timeout * 1000) {
        console.log('Too many errors, full hls reinit');
        last_error_time = now;
        return fullHlsReinit();
      } 
      if (data.fatal) {
        errors_count += 1;
        last_error_time = now;
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            if (is_first_loaded) {
              setTimeout(function() {
                hls.startLoad();
              }, config.first_load_error_retry_time * 1000);
            } else {
              fullHlsReinit();
            }
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
    });

    hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, function(event, data) {
      tech.clearTracks('audio');
      var tracks = data.audioTracks || [];
      for (var i=0; i < tracks.length; i++) {
        var track = tracks[i];
        var videojs_track = new videojs.AudioTrack({
          id: track.id,
          enabled: track.default,
          language: track.lang,
          label: track.name
        });
        videojs_track.properties_ = track;
        tech.audioTracks().addTrack(videojs_track);
      }
    });

    Object.keys(Hls.Events).forEach(function(key) {
      var eventName = Hls.Events[key];
      hls.on(eventName, function(event, data) {
        tech.trigger(eventName, data);
      });
    });
  }

  /**
   *
   */
  this.dispose = function() {
    hls.destroy();
    tech.audioTracks().removeEventListener('change', audioTrackChange);
    this.player.hls_ = null;
  };

  /**
   * returns the duration of the stream, or Infinity if live video
   * @returns {Infinity|number}
   */
  this.duration = function() {
    return is_live ? Infinity : el.duration || 0;
  };

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

  player.on('ready', function() {
    tech.audioTracks().addEventListener('change', audioTrackChange);
  });

  // attach hlsjs to videotag
  hlsAddEventsListeners();
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
  videojs = videojs.default || videojs;

  if (videojs) {
    videojs.getTech('Html5').registerSourceHandler(HlsSourceHandler, 0);
  } else {
    console.warn('videojs-contrib-hls.js: Couldn\'t find find window.videojs nor require(\'video.js\')');
  }
}
