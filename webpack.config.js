'use strict';

const path = require('path');
const webpack = require('webpack');
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
      popup: './src/UIElements/popup/index.tsx'
    },
    output: {
      path: path.resolve(__dirname, 'assets'),
      filename: 'js/[name].[contenthash].js',
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
        chunks: 'all',
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
        crypto: require.resolve('crypto-browserify'),
        stream: require.resolve('stream-browserify'),
        buffer: require.resolve('buffer/'),
        util: require.resolve('util/')
      },
      alias: {
        vm: 'vm-browserify'
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
          use: [
            MiniCssExtractPlugin.loader,
            'css-loader'
          ],
          include: [
            path.join(__dirname, 'node_modules/semantic-ui-css'),
            path.join(__dirname, 'assets')
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
      new webpack.ProvidePlugin({
        process: 'process/browser',
        Buffer: ['buffer', 'Buffer']
      }),
      new webpack.IgnorePlugin({
        resourceRegExp: /^\.\/wordlists\/(?!english)/,
        contextRegExp: /bip39/
      }),
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
