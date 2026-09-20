import path from 'path';
import { fileURLToPath } from 'url';
import MiniCssExtractPlugin from 'mini-css-extract-plugin';
import CopyWebpackPlugin from 'copy-webpack-plugin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default {
  entry: {
    'service-worker': './src/background/service-worker.js',
    'content': './src/content/content-main.js',
    'popup': './src/popup/popup.js',
    'options': './src/options/options.js',
    'youtube-shield': './src/content/youtube-shield.js',
    // Scriptlets bundle injected into MAIN world — must be self-contained
    'scriptlets-world': './src/scriptlets/index.js',
  },

  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    clean: true,
    assetModuleFilename: '[name][ext]', // Keep filenames static for WASM
    publicPath: '',  // Prevent webpack's auto-detection IIFE (fails in extension MAIN world content scripts)
  },

  module: {
    rules: [
      {
        test: /\.css$/,
        use: [MiniCssExtractPlugin.loader, 'css-loader'],
      },
    ],
  },

  plugins: [
    new MiniCssExtractPlugin({ filename: '[name].css' }),
    // Narrow Copy — wasm-pack emits to `src/shared/wasm/`, but the manifest
    // can load either the repo-root manifest or a generated dist manifest.
    // Keep a copy beside the generated bundles so both layouts can resolve it.
    new CopyWebpackPlugin({
      patterns: [
        {
          from: path.resolve(__dirname, 'src/shared/wasm/nullify_core_bg.wasm'),
          // Relative, so it lands in `output.path` wherever that points. An
          // absolute target is rewritten relative to output.path by
          // copy-webpack-plugin, so `--output-path <elsewhere>` still wrote
          // the repo's own dist/ — overwriting the WASM in a loaded unpacked
          // extension while its dist/service-worker.js kept the old glue.
          to: 'nullify_core_bg.wasm',
          noErrorOnMissing: false,
        },
      ],
    }),
  ],

  resolve: {
    extensions: ['.js'],
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@scriptlets': path.resolve(__dirname, 'src/scriptlets'),
    },
  },

  optimization: {
    // Every entry is a single chunk. Content scripts (`content`,
    // `youtube-shield`) and the MAIN-world scriptlets bundle have no
    // chunk-loading runtime, and the extension pages are no better off:
    // popup.html and options.html each load exactly ONE script by name, so a
    // numbered chunk is emitted that nothing loads and both pages die at
    // load. This block used to exempt only the first group, on the theory
    // that a page with a document can fetch a chunk — it cannot, unless the
    // HTML asks for it. The margin was 8.6 KB against the 20 KB `minSize`
    // until the generated public-suffix table landed (§9.15).
    splitChunks: false,
  },
};
