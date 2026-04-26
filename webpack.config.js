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
          to: path.resolve(__dirname, 'dist/nullify_core_bg.wasm'),
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
    // Keep service worker as a single chunk — Chrome requires it
    splitChunks: {
      chunks(chunk) {
        return chunk.name !== 'service-worker' && chunk.name !== 'scriptlets-world';
      },
    },
  },
};
