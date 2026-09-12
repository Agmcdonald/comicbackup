#!/usr/bin/env node
'use strict';
/**
 * cli.js — comicgrab from the terminal. No Electron needed.
 *
 *   node cli.js <url> [-e 1-10] [-n "Name"] [-o DIR] [--stitch] [--one-cbz] [--keep] [--numbered] [--repair] [--force] [-g year|storyline]
 */

const { parseArgs } = require('node:util');
const { grab } = require('./engine');

const USAGE = `usage: comicgrab <url> [options]

  -e, --episodes  series modes: "all", "3", "1-10", "1,4,9-12"   (default: all)
  -n, --name      override the detected series title
  -o, --out       output folder                       (default: ~/Downloads/Comics)
      --stitch    merge each episode/gallery into tall JPEG strip(s)
      --one-cbz   series modes: merge everything into a single CBZ
      --keep      keep the loose image folders after zipping
      --numbered  name episode files "0001 - Title.cbz" instead of "Series - Title.cbz"
      --repair    site adapters: fetch only pages missing from an existing CBZ and rewrite it
      --force     re-download files that already exist (default: skip them)
  -g, --group     site adapters: how to split — bobandgeorge: year (default) or storyline
  -h, --help

examples:
  comicgrab "https://www.webtoons.com/en/.../list?title_no=10656"
  comicgrab <any-comic-url> -e 1-10 --stitch
`;

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      episodes: { type: 'string', short: 'e', default: 'all' },
      name:     { type: 'string', short: 'n' },
      out:      { type: 'string', short: 'o' },
      stitch:   { type: 'boolean', default: false },
      'one-cbz': { type: 'boolean', default: false },
      keep:     { type: 'boolean', default: false },
      numbered: { type: 'boolean', default: false },
      repair:   { type: 'boolean', default: false },
      force:    { type: 'boolean', default: false },
      group:    { type: 'string', short: 'g' },
      help:     { type: 'boolean', short: 'h', default: false },
    },
  });
} catch (e) {
  console.error(e.message);
  console.error(USAGE);
  process.exit(2);
}

if (args.values.help || args.positionals.length !== 1) {
  console.log(USAGE);
  process.exit(args.values.help ? 0 : 2);
}

const onProgress = (ev) => {
  const prefix = ev.type === 'warn' ? '  ! ' : ['download', 'item', 'skip'].includes(ev.type) ? '  ' : '';
  if (ev.msg) console.log(prefix + ev.msg);
};

grab(args.positionals[0], {
  episodes: args.values.episodes,
  name: args.values.name,
  outDir: args.values.out,
  stitch: args.values.stitch,
  oneCbz: args.values['one-cbz'],
  keep: args.values.keep,
  numbered: args.values.numbered,
  repair: args.values.repair,
  force: args.values.force,
  group: args.values.group,
  onProgress,
}).catch((e) => {
  console.error(`\nerror: ${require('./engine').why(e)}`);
  process.exit(1);
});
