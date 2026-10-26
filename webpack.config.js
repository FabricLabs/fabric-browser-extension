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

function fabricCoreRoots (release) {
  const roots = [];
  if (process.env.FABRIC_CORE) roots.push(path.resolve(process.env.FABRIC_CORE));
  // Release builds stay reproducible: no sibling checkout unless FABRIC_CORE asks for one.
  if (process.env.FABRIC_CORE || !release) roots.push(path.resolve(__dirname, '../fabric-clean'));
  roots.push(path.resolve(__dirname, 'node_modules/@fabric/core'));
  return roots;
}
/** Core tree for Passport sign-in and accounts (same order as `src/utils/loadFabricPassport.js`). */
function resolveFabricPassportCoreRoot (release) {
  for (const root of fabricCoreRoots(release)) {
    if (fs.existsSync(path.join(root, 'functions', 'passport.js')) && fs.existsSync(path.join(root, 'functions', 'accountKeys.js'))) {
      console.log(`[webpack] Passport core: ${root}`);
      return root;
    }
  }
  throw new Error('Passport needs @fabric/core with functions/passport.js and functions/accountKeys.js (set FABRIC_CORE or clone ../fabric-clean)');
}
/** Core tree for named federations (same order as `src/utils/loadFabricFederation.js`). */
function resolveFabricFederationCoreRoot (release) {
  for (const root of fabricCoreRoots(release)) {
    const file = path.join(root, 'types', 'federation.js');
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('MESSAGE_TYPES')) {
      console.log(`[webpack] federations core: ${root}`);
      return root;
    }
  }
  throw new Error('Federations need @fabric/core whose types/federation has the member messages (set FABRIC_CORE or clone ../fabric-clean)');
}
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyPlugin = require('copy-webpack-plugin');
const ProgressBar = require('progress-bar-webpack-plugin');
const TerserPlugin = require('terser-webpack-plugin');

module.exports = (env, argv) => {
  const isProduction = (env && env.NODE_ENV === 'production') || process.env.NODE_ENV === 'production';
  const release = isProduction || !!(argv && argv.mode === 'production');

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
      publicPath: '/',
      // Drop prior contenthashed popup/vendors chunks. Do not clean: true —
      // that would wipe assets/icons before CopyPlugin recopies them.
      clean: {
        keep: (filename) => {
          const f = String(filename || '').replace(/\\/g, '/');
          return !/^js\/(popup|vendors)\.[a-f0-9]+\.js(\.map)?$/.test(f);
        }
      }
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
            // Content scripts and the service worker load as single files; only the popup HTML
            // includes the vendors chunk.
            chunks: (chunk) => chunk.name === 'popup'
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
        // Core `Service` lazy-requires `Peer` (TCP); never reached in the extension.
        net: false,
        path: require.resolve('path-browserify'),
        crypto: require.resolve('@fabric/http/functions/browserCrypto'),
        stream: require.resolve('stream-browserify'),
        buffer: require.resolve('buffer/'),
        util: require.resolve('util/'),
        // Absolute: linked ../fabric-clean bech32 must not look for process under fabric-clean/node_modules.
        process: require.resolve('process/browser')
      },
      alias: {
        'process/browser': require.resolve('process/browser'),
        // Every `require('buffer')` (and the provided global) gets the base64url-capable polyfill.
        buffer$: path.resolve(__dirname, 'shims/buffer.browser.js'),
        // Package exports only expose ./constants for `require`; map explicitly for webpack/browser.
        '@fabric/core/constants': path.resolve(__dirname, 'node_modules/@fabric/core/constants.js'),
        '@fabric/core/types/message': path.resolve(__dirname, 'node_modules/@fabric/core/types/message.js'),
        '@fabric/http/assets': path.resolve(__dirname, 'node_modules/@fabric/http/assets'),
        'fabric-passport-core': resolveFabricPassportCoreRoot(release),
        [path.resolve(__dirname, 'src/utils/loadFabricPassport.js')]: path.resolve(__dirname, 'src/utils/fabricPassportCore.browser.js'),
        'fabric-federation-core': resolveFabricFederationCoreRoot(release),
        [path.resolve(__dirname, 'src/utils/loadFabricFederation.js')]: path.resolve(__dirname, 'src/utils/fabricFederationCore.browser.js')
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
