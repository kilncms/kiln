// Stands in for playwright-core in the one test that must get past "is it
// installed" to reach "is there a browser". It never starts anything.
module.exports = { chromium: { launch() { throw new Error('the fake playwright cannot start a browser'); } } };
