import path from 'path';
import { fileURLToPath } from 'url';
import CopyWebpackPlugin from 'copy-webpack-plugin';
import MiniCssExtractPlugin from 'mini-css-extract-plugin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default {
  entry: {
    'service-worker': './src/background/service-worker.js',
    'content': './src/content/content-main.js',
    'popup': './src/popup/popup.js',
    'options': './src/options/options.js',
    // Scriptlets bundle injected into MAIN world — must be self-contained
    'scriptlets-world': './src/scriptlets/index.js',
  },

  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    clean: true,
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

    new CopyWebpackPlugin({
      patterns: [
        { from: 'manifest.json', to: '../manifest.json' },
        { from: 'assets', to: '../assets' },
        { from: 'rules', to: '../rules', noErrorOnMissing: true },
        { from: 'src/popup/popup.html', to: '../src/popup/popup.html' },
        { from: 'src/options/options.html', to: '../src/options/options.html' },
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
