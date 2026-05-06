const path = require('path');
const webpack = require('webpack');
const CopyWebpackPlugin = require('copy-webpack-plugin');

// Fava slugifies the journal title for its URL prefix. Override at build time
// (e.g. `FAVA_LEDGER_SLUG=my-ledger npm run build`) to point the extension at
// your own ledger without checking the slug into this public repo.
const FAVA_LEDGER_SLUG = process.env.FAVA_LEDGER_SLUG || 'acme-demo';

module.exports = {
  entry: {
    content: './src/index.js',
  },
  output: {
    filename: '[name].js',
    path: path.resolve(__dirname, 'build')
  },
  mode: 'production',
  plugins: [
    new webpack.DefinePlugin({
      'process.env.FAVA_LEDGER_SLUG': JSON.stringify(FAVA_LEDGER_SLUG),
    }),
    new CopyWebpackPlugin({
      patterns: [
        { from: 'src/manifest.json', to: 'manifest.json' },
      ],
    }),
  ],
};
