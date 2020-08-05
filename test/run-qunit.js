/*eslint no-console: ["error", { allow: ["log", "error"] }] */

// Chrome QUnit Test Runner
// Author: David Taylor
// Requires chrome-launcher and chrome-remote-interface from npm
// An up-to-date version of chrome is also required

/* globals Promise */

var args = process.argv.slice(2);

if (args.length < 1 || args.length > 3) {
  console.log("Usage: node run-qunit.js <URL> <timeout> <result_file>");
  process.exit(1);
}

const chromeLauncher = require("chrome-launcher");
const CDP = require("chrome-remote-interface");

const QUNIT_RESULT = args[2];
const fs = require("fs");

if (QUNIT_RESULT) {
  (async () => {
    await fs.stat(QUNIT_RESULT, (err, stats) => {
      if (stats && stats.isFile())
        fs.unlink(QUNIT_RESULT, unlinkErr => {
          if (unlinkErr) {
            console.log("Error deleting " + QUNIT_RESULT + " " + unlinkErr);
          }
        });
    });
  })();
}

async function runAllTests() {
  function launchChrome() {
    const options = {
      chromeFlags: [
        "--disable-gpu",
        "--headless",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--mute-audio",
        "--window-size=1440,900"
      ]
    };

    if (process.env.REMOTE_DEBUG) {
      options.port = 9222;
    }

    return chromeLauncher.launch(options);
  }

  let chrome = await launchChrome();

  let protocol = null;
  let connectAttempts = 0;
  while (!protocol) {
    // Workaround for intermittent CI error caused by
    // https://github.com/GoogleChrome/chrome-launcher/issues/145
    try {
      protocol = await CDP({ port: chrome.port });
    } catch (e) {
      if (e.message === "No inspectable targets" && connectAttempts < 50) {
        connectAttempts++;
        console.log(
          "Unable to establish connection to chrome target - trying again..."
        );
        await new Promise(resolve => setTimeout(resolve, 100));
      } else {
        throw e;
      }
    }
  }

  const { Inspector, Page, Runtime } = protocol;

  await Promise.all([Inspector.enable(), Page.enable(), Runtime.enable()]);

  Inspector.targetCrashed(entry => {
    console.log("Chrome target crashed:");
    console.log(entry);
  });

  Runtime.exceptionThrown(exceptionInfo => {
    console.log(exceptionInfo.exceptionDetails.exception.description);
  });

  Runtime.consoleAPICalled(response => {
    const message = response["args"][0].value;

    // Not finished yet, don't add a newline
    if (message && message.startsWith && message.startsWith("↪")) {
      process.stdout.write(message);
    } else if (
      message &&
      message.startsWith &&
      message.startsWith("AUTOSPEC:")
    ) {
      fs.appendFileSync(QUNIT_RESULT, `${message.slice(10)}\n`);
    } else {
      console.log(message);
    }
  });

  console.log("navigate to " + args[0]);
  Page.navigate({ url: args[0] });

  Page.loadEventFired(async () => {
    await Runtime.evaluate({
      expression:
        `const QUNIT_FAIL_FAST = ` +
        (process.env.QUNIT_FAIL_FAST === "true").toString() +
        ";"
    });
    await Runtime.evaluate({
      expression: `(${qunit_script})();`
    });

    if (args[0].indexOf("report_requests=1") > -1) {
      await Runtime.evaluate({
        expression: "QUnit.config.logAllRequests = true"
      });
    }

    const timeout = parseInt(args[1] || 300000, 10);
    var start = Date.now();

    var interval;

    let runTests = async function() {
      if (Date.now() > start + timeout) {
        console.error("Tests timed out");
        protocol.close();
        chrome.kill();
        process.exit(124);
      }

      let numFails = await Runtime.evaluate({
        expression: `(${check_script})()`
      });

      if (numFails && numFails.result && numFails.result.type !== "undefined") {
        clearInterval(interval);
        protocol.close();
        chrome.kill();

        if (numFails.result.value > 0) {
          process.exit(1);
        } else {
          process.exit();
        }
      }
    };

    interval = setInterval(runTests, 250);
  });
}

runAllTests().catch(e => {
  console.log("Failed to run tests: " + e);
  process.exit(1);
});

// The following functions are converted to strings
// And then sent to chrome to be evalaluated
function logQUnit() {
  let testErrors = [];
  let assertionErrors = [];

  console.log("\nRunning: " + JSON.stringify(QUnit.urlParams) + "\n");

  QUnit.config.testTimeout = 10000;

  let durations = {};

  let inTest = false;
  QUnit.testStart(function(context) {
    console.log("↪ " + context.module + "::" + context.name);
    inTest = true;
  });

  QUnit.testDone(function(context) {
    durations[context.module + "::" + context.name] = context.runtime;

    if (context.failed) {
      const msg =
        "  Test Failed: " +
        context.name +
        assertionErrors.join("    ") +
        "\n" +
        context.source;
      testErrors.push(msg);
      assertionErrors = [];

      // Pass QUNIT_FAIL_FAST on the command line to quit after the first failure
      if (QUNIT_FAIL_FAST) {
        QUnit.config.queue.length = 0;
      }
      if (inTest) {
        console.log(" [✘]");
      }
    } else {
      if (inTest) {
        console.log(" [✔]");
      }
    }
    inTest = false;
  });

  QUnit.log(function(context) {
    if (context.result) {
      return;
    }

    var msg = "\n    Assertion Failed:";
    if (context.message) {
      msg += " " + context.message;
    }

    if (context.expected) {
      msg +=
        "\n      Expected: " + context.expected + ", Actual: " + context.actual;
    }

    assertionErrors.push(msg);
  });

  QUnit.done(function(context) {
    console.log("\n");

    if (testErrors.length) {
      console.log("Test Errors");
      console.log("----------------------------------------------");
      testErrors.forEach(e => {
        console.error(e);
      });
      console.log("\n");
    }

    console.log("Slowest tests");
    console.log("----------------------------------------------");
    let ary = Object.keys(durations).map(key => ({
      key: key,
      value: durations[key]
    }));
    ary.sort((p1, p2) => p2.value - p1.value);
    ary.slice(0, 30).forEach(pair => {
      console.log(pair.key + ": " + pair.value + "ms");
    });

    var stats = [
      "Time: " + context.runtime + "ms",
      "Total: " + context.total,
      "Passed: " + context.passed,
      "Failed: " + context.failed
    ];
    console.log(stats.join(", "));

    if (context.failed) {
      console.log("\nUse this filter to run in the same order:");
      console.log(
        "QUNIT_FAIL_FAST=true QUNIT_SEED=" +
          QUnit.config.seed +
          " rake qunit:test\n"
      );
      console.log("If you have a web environment running, you can visit:");
      console.log(
        "http://localhost:3000/qunit?hidepassed&seed=" +
          QUnit.config.seed +
          "\n\n"
      );
    }

    window.qunitDone = context;
  });
}
let qunit_script = logQUnit.toString();

if (QUNIT_RESULT) {
  qunit_script = qunit_script.replace(
    "/* QUNIT_RESULT */",
    "console.log(`AUTOSPEC: ${context.module}:::${context.testId}:::${context.name}`);"
  );
}

function check() {
  if (window.qunitDone) {
    return window.qunitDone.failed;
  }
}

const check_script = check.toString();
