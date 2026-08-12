'use strict';

const fs = require('fs');
const path = require('path');
const webpack = require('webpack');
const packageJson = require('./package.json');

/** Themes + fonts for `@fabric/http` Semantic (Fomantic); CSS uses `url(themes/fabric/...)` relative to `css/*.css`. */
const FABRIC_HTTP_PKG = path.resolve(__dirname, 'node_modules/@fabric/http');
let FABRIC_HTTP_ROOT = FABRIC_HTTP_PKG;
try {
  // npm link / file: installs resolve outside node_modules; webpack include must use realpath.
  FABRIC_HTTP_ROOT = fs.realpathSync(FABRIC_HTTP_PKG);
} catch (_) {
  if (process.env.FABRIC_HTTP && fs.existsSync(process.env.FABRIC_HTTP)) {
    FABRIC_HTTP_ROOT = path.resolve(process.env.FABRIC_HTTP);
  } else if (fs.existsSync(path.resolve(__dirname, '../fabric-http'))) {
    FABRIC_HTTP_ROOT = path.resolve(__dirname, '../fabric-http');
  }
}
const FABRIC_HTTP_ASSETS = path.join(FABRIC_HTTP_ROOT, 'assets');
const FABRIC_HTTP_ASSETS_ALIASES = Array.from(new Set([
  FABRIC_HTTP_ASSETS,
  path.join(FABRIC_HTTP_PKG, 'assets'),
  path.resolve(__dirname, '../fabric-http/assets')
].filter((p) => fs.existsSync(p))));

/** Prefer sibling / FABRIC_HTTP checkout so invite JSON helpers stay current. */
function resolveFabricHttpInviteModule () {
  const roots = [];
  if (process.env.FABRIC_HTTP) roots.push(path.resolve(process.env.FABRIC_HTTP));
  roots.push(path.resolve(__dirname, '../fabric-http'));
  roots.push(path.resolve(__dirname, 'node_modules/@fabric/http'));
  for (const root of roots) {
    const file = path.join(root, 'functions', 'federationContractInvite.js');
    if (fs.existsSync(file)) return file;
  }
  return path.resolve(__dirname, 'node_modules/@fabric/http/functions/federationContractInvite.js');
}
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyPlugin = require('copy-webpack-plugin');
const ProgressBar = require('progress-bar-webpack-plugin');
const TerserPlugin = require('terser-webpack-plugin');

module.exports = (env) => {
  const isProduction = env.NODE_ENV === 'production';

  return {
    mode: isProduction ? 'production' : 'development',
    entry: {
      popup: './src/UIElements/popup/index.tsx',
      contentMarker: './src/contentMarker.ts',
      content: './src/content.ts',
      background: './src/background/serviceWorkerMain.ts',
      offscreen: './src/background/offscreenMain.ts'
    },
    output: {
      path: path.resolve(__dirname, 'assets'),
      filename: (pathData) => {
        const n = pathData.chunk.name;
        if (n === 'content' || n === 'contentMarker') return 'js/[name].js';
        if (n === 'background') return 'background/serviceWorker.js';
        if (n === 'offscreen') return 'background/offscreen.js';
        return 'js/[name].[contenthash].js';
      },
      publicPath: '/'
    },
    optimization: {
      minimize: isProduction,
      minimizer: [
        new TerserPlugin({
          terserOptions: {
            compress: {
              drop_console: isProduction,
              drop_debugger: isProduction
            },
            format: {
              comments: false
            }
          },
          extractComments: false
        })
      ],
      splitChunks: {
        chunks: (chunk) => chunk.name === 'popup',
        cacheGroups: {
          vendor: {
            test: /[\\/]node_modules[\\/]/,
            name: 'vendors',
            chunks: 'all'
          }
        }
      }
    },
    experiments: {
      asyncWebAssembly: true
    },
    resolve: {
      extensions: ['.tsx', '.ts', '.js', '.jsx', '.json', '.wasm'],
      fallback: {
        // fabricNativeAccel is stubbed below; keep fs/path from breaking other Node-only probes.
        fs: false,
        path: require.resolve('path-browserify'),
        crypto: require.resolve('crypto-browserify'),
        stream: require.resolve('stream-browserify'),
        buffer: require.resolve('buffer/'),
        util: require.resolve('util/'),
        // Absolute: linked ../fabric-clean bech32 must not look for process under fabric-clean/node_modules.
        process: require.resolve('process/browser')
      },
      alias: {
        vm: 'vm-browserify',
        'process/browser': require.resolve('process/browser'),
        // Package exports only expose ./constants for `require`; map explicitly for webpack/browser.
        '@fabric/core/constants': path.resolve(__dirname, 'node_modules/@fabric/core/constants.js'),
        '@fabric/core/types/message': path.resolve(__dirname, 'node_modules/@fabric/core/types/message.js'),
        '@fabric/http/assets': path.resolve(__dirname, 'node_modules/@fabric/http/assets'),
        '@fabric/http/functions/federationContractInvite': resolveFabricHttpInviteModule(),
        // Browser: skip Node fs/createRequire loader; use the aliased http module directly.
        [path.resolve(__dirname, 'src/utils/loadFederationContractInvite.js')]: resolveFabricHttpInviteModule()
      }
    },
    module: {
      rules: [
        {
          test: /\.wasm$/,
          type: 'webassembly/async'
        },
        {
          test: /\.[jt]sx?$/,
          use: {
            loader: 'babel-loader',
            options: {
              presets: [
                '@babel/preset-env',
                ['@babel/preset-react', { runtime: 'automatic' }],
                '@babel/preset-typescript'
              ]
            }
          },
          exclude: /node_modules/,
          include: [
            path.resolve(__dirname, 'src')
          ],
        },
        {
          test: /\.css$/,
          oneOf: [
            {
              // Keep @fabric/http semantic bundle untouched; it embeds data: font URLs.
              // Include realpath (npm link) as well as the node_modules path.
              include: FABRIC_HTTP_ASSETS_ALIASES,
              use: [
                MiniCssExtractPlugin.loader,
                {
                  loader: 'css-loader',
                  options: {
                    url: false
                  }
                }
              ]
            },
            {
              use: [
                MiniCssExtractPlugin.loader,
                'css-loader'
              ],
              include: [
                path.join(__dirname, 'node_modules/semantic-ui-css'),
                path.join(__dirname, 'assets')
              ]
            }
          ]
        },
        {
          test: /\.(s[ac]|c)ss$/i,
          use: [
            MiniCssExtractPlugin.loader,
            'css-loader',
            'sass-loader'
          ],
          include: [
            path.join(__dirname, 'src')
          ],
          exclude: [
            path.join(__dirname, 'node_modules/semantic-ui-css')
          ]
        },
        {
          test: /\.(png|svg|jpe?g|gif)$/i,
          type: 'asset/resource',
          generator: {
            filename: 'img/[hash][ext][query]',
          },
        },
        {
          test: /\.(woff|woff2|eot|ttf|otf)$/i,
          type: 'asset/resource',
          generator: {
            filename: 'fonts/[hash][ext][query]',
          },
        }
      ],
    },
    plugins: [
      new webpack.DefinePlugin({
        __PASSPORT_EXTENSION_VERSION__: JSON.stringify(packageJson.version),
        /** Dev/test hook: `FABRIC_ACTION` background fetch target (see tests). */
        __FABRIC_ACTION_DEBUG_URL__: JSON.stringify(
          process.env.FABRIC_ACTION_DEBUG_URL || 'http://localhost:3003/api/endpoint'
        )
      }),
      new webpack.ProvidePlugin({
        process: require.resolve('process/browser'),
        Buffer: ['buffer', 'Buffer']
      }),
      new webpack.IgnorePlugin({
        resourceRegExp: /^\.\/wordlists\/(?!english)/,
        contextRegExp: /bip39/
      }),
      // Stub optional fabric.node (dynamic require). Matches npm package and file:../fabric-clean symlink.
      new webpack.NormalModuleReplacementPlugin(
        /[\\/](@fabric[\\/]core|fabric-clean)[\\/]functions[\\/]fabricNativeAccel\.js$/,
        path.resolve(__dirname, 'shims/fabricNativeAccel.browser.js')
      ),
      new HtmlWebpackPlugin({
        filename: 'popup.html',
        template: 'src/UIElements/popup/index.html',
        chunks: ['popup'],
      }),
      new CopyPlugin({
        patterns: [
          {
            from: 'src/manifest.json',
            to: 'manifest.json'
          },
          {
            from: 'assets/icons',
            to: 'icons'
          },
          {
            from: 'src/background/offscreen.html',
            to: 'background/offscreen.html'
          },
          {
            from: 'src/test.html',
            to: 'test.html'
          },
          {
            from: 'src/hub-mesh-bridge.html',
            to: 'hub-mesh-bridge.html'
          },
          {
            from: path.join(FABRIC_HTTP_ASSETS, 'themes'),
            to: 'css/themes'
          }
        ],
      }),
      new MiniCssExtractPlugin({
        filename: 'css/[name].css',
      }),
      isProduction && new ProgressBar()
    ].filter(Boolean),
    devtool: isProduction ? false : 'source-map',
    devServer: {
      port: 3003,
      host: 'localhost',
      open: true,
      compress: true,
      static: {
        directory: path.join(__dirname, 'assets'),
        publicPath: '/',
        watch: {
          poll: true,
          ignored: /node_modules/
        }
      },
      headers: {
        'Access-Control-Allow-Origin': '*'
      }
    }
  };
};
