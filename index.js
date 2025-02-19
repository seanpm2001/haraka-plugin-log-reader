'use strict';

// node.js built-in modules
const spawn = require('child_process').spawn;

let log = '/var/log/haraka.log';
let plugin;

exports.register = function () {
  plugin = this;
  plugin.get_logreader_ini();
  plugin.load_karma_ini();
}

exports.hook_init_http = function (next, server) {
  server.http.app.use('/logs/:uuid', exports.get_logs);
  server.http.app.use('/karma/rules', exports.get_rules);
  next();
}

exports.get_logreader_ini = function () {
  plugin = this;
  plugin.cfg = plugin.config.get('log.reader.ini', function () {
    plugin.get_logreader_ini();
  })

  if (plugin.cfg.log && plugin.cfg.log.file) {
    log = plugin.cfg.log.file;
  }
}

exports.load_karma_ini = function () {
  plugin.karma_cfg = plugin.config.get('karma.ini', function () {
    plugin.load_karma_ini();
  })

  if (!plugin.karma_cfg.result_awards) return;
  if (!plugin.result_awards) plugin.result_awards = {};

  Object.keys(plugin.karma_cfg.result_awards).forEach(function (anum) {
    const parts = plugin.karma_cfg.result_awards[anum]
      .replace(/\s+/, ' ')
      .split(/(?:\s*\|\s*)/);

    plugin.result_awards[anum] = {
      pi_name    : parts[0],
      property   : parts[1],
      operator   : parts[2],
      value      : parts[3],
      award      : parts[4],
      reason     : parts[5],
      resolution : parts[6],
    };
  });
}

exports.get_rules = function (req, res) {
  res.send(JSON.stringify(plugin.result_awards));
}

exports.get_logs = function (req, res) {

  const uuid = req.params.uuid;
  if (!/-/.test(uuid)) {
    return res.send('<html><body>Invalid Request</body></html>');
  }
  if (!/^[0-9A-F\-.]{12,40}$/.test(uuid)) {
    return res.send('<html><body>Invalid Request</body></html>');
  }

  // spawning a grep process is quite a lot faster than fs.read
  // (yes, I benchmarked it)
  exports.grepWithShell(log, uuid, function (err, matched) {
    if (err) return res.send('<p>' + err + '</p>');

    exports.asHtml(uuid, matched, function (html) {
      res.send(html);
    });
  });
}

exports.grepWithShell = function (file, uuid, done) {

  let matched = '';
  let searchString = uuid;

  if (/\.[0-9]{1,2}$/.test(uuid)) {
    // strip transaction off ID, so connection properties are included
    searchString = uuid.replace(/\.[0-9]{1,2}$/, '');
  }

  // var child = spawn('grep', [ '-e', regex, file ]);
  const child = spawn('grep', [ '--text', searchString, file ]);
  child.stdout.on('data', function (buffer) {
    matched += buffer.toString();
  });

  child.stdout.on('end', function (err) {
    done(err, matched);
  });
};

exports.asHtml = function (uuid, matched, done) {

  let rawLogs = ''
  let lastKarmaLine
  let monthDay = ''
  const matchMonthDay = new RegExp('^([A-Z][a-z]{2}[ ]{1,2}[0-9]{1,2}) ');

  matched.split('\n').forEach((line) => {

    if (!line) return;

    let transId;
    let replaceString = '';

    if (!monthDay) {
      try {
        [, monthDay] = matchMonthDay.exec(line)
      }
      catch (err) {
        plugin.loginfo(line)
        plugin.logerror(err)
      }
    }

    const uuidMatch = line.match(/ \[([A-F0-9\-.]{12,40})\] /);
    if (uuidMatch && uuidMatch[1]) {
      transId = uuidMatch[1].match(/\.([0-9]{1,2})$/);
    }
    if (transId && transId[1]) replaceString = '[' + transId[1] + '] ';

    let trimmed = line
      .replace(/\[[A-F0-9\-.]{12,40}\] /, replaceString)  // UUID
      .replace(matchMonthDay, '');                        // Mon DD

    // strip prepended hostname
    if ( / haraka\[[0-9]+\]: /.test(trimmed) ) {    // with PID
      trimmed = trimmed.replace(/(?: [a-z.-]+)? haraka\[[0-9]+\]: /, ' ');
    }
    else if ( / haraka: \[/.test(trimmed) ) {       // w/o PID
      trimmed = trimmed.replace(/(?: [a-z.-]+)? haraka: /, ' ');
    }

    rawLogs += trimmed + '<br>';
    if (/\[karma/.test(line) && /awards/.test(line)) {
      lastKarmaLine = line;
    }
  })

  let awardNums = [];
  if (lastKarmaLine) {
    const bits = lastKarmaLine.match(/awards: ([0-9,]+)?\s*/);
    if (bits && bits[1]) awardNums = bits[1].split(',');
  }

  done(
    htmlHead() +
    htmlBody(
      `for connection ${uuid} on ${monthDay}`,
      getAwards(awardNums).join(''),
      getResolutions(awardNums).join('')
    ) +
    rawLogs + '</pre></div></body></html>'
  );
}

// exports.grepWithFs = function (file, regex, done) {
//     var wantsRe = new RegExp(regex);
//     var fsOpts = { flag: 'r', encoding: 'utf8' };
//     require('fs').readFile(log, fsOpts, function (err, data) {
//         if (err) throw (err);
//         var res = '';
//         data.toString().split(/\n/).forEach(function (line) {
//             if (wantsRe && !wantsRe.test(line)) return;
//             res += line + '\n';
//         });
//         done(null, res);
//     });
// };

function getAwards (awardNums) {
  if (!awardNums || awardNums.length === 0) return [];

  const awards = [];
  awardNums.forEach(function (a) {
    if (!a || !plugin.result_awards[a]) return;
    plugin.result_awards[a].id = a;
    awards.push(plugin.result_awards[a]);
  });

  const listItems = [];
  awards.sort(sortByAward).forEach(function (a) {
    const start = '<li> ' + a.award + ',  ';
    if (a.reason) {
      listItems.push(start + a.reason + ' (' + a.value + ')</li>');
      return;
    }
    listItems.push(start + a.pi_name + ' ' + a.property +
                ' ' + a.value + '</li>');
  });
  return listItems;
}

function getResolutions (awardNums) {
  if (!awardNums || awardNums.length === 0) return [];

  const awards = [];
  awardNums.forEach(function (a) {
    if (!a || !plugin.result_awards[a]) return;
    awards.push(plugin.result_awards[a]);
  });

  const listItems = [];
  const resolutionSeen = {};
  awards.sort(sortByAward).forEach(function (a) {
    if (!a.resolution) return;
    if (resolutionSeen[a.resolution]) return;
    resolutionSeen[a.resolution] = true;
    listItems.push('<li>' + a.resolution + '</li>');
  });
  return listItems;
}

function sortByAward (a, b) {
  if (parseFloat(b.award) > parseFloat(a.award)) return -1;
  if (parseFloat(b.award) < parseFloat(a.award)) return  1;
  return 0;
}

function htmlHead () {
  const str = '<html> \
        <head> \
          <meta charset="utf-8"> \
          <link rel="stylesheet" href="/haraka/css/bootstrap.min.css"> \
          <link rel="stylesheet" href="/haraka/css/bootstrap-theme.min.css"> \
          <style> \
            div { padding: 1em; } \
          </style> \
        </head>';
  return str;
}

function htmlBody (uuid, awards, resolve) {
  let str = '<body> \
        <div class="tab-content"> \
        <h3>Sorry if we blocked your message:</h3> \
        <p>Our filters mistook your server for a malicious computer attempting \
        to send spam. To improve your mail servers reputation, please contact \
        your IT helpdesk or Systems Administrator and ask them for help.</p>';

  if (awards) {
    str += '<hr><h3>Policy Rules Matched</h3> \
        <ul>' + awards + '</ul>';
  }

  if (resolve) {
    str += '<hr><h3>Steps to Resolve</h3> \
        <ul>' + resolve + '</ul>';
  }

  str += '<hr> \
        <h3>Raw Logs</h3> \
        <p>' + uuid + '</p> \
        <pre> \
        \n';
  return str;
}
