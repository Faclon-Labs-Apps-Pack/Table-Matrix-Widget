import path from 'path';
import { fileURLToPath } from 'url';
import webpack from 'webpack';
import MiniCssExtractPlugin from 'mini-css-extract-plugin';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// design-sdk's compiled components each `import "./Something.css"` from inside
// the package. Webpack follows those, so without this every bundle carried its
// own copy of the SDK's rules and leaked them onto sibling widgets on a Lens
// dashboard. Redirect any CSS request *made from inside the package* to an
// empty file; the host loads the real styles.css.
const DESIGN_SDK_DIR = path.join('@faclon-labs', 'design-sdk');
const HOST_PROVIDED_STYLES = path.resolve(__dirname, 'src/iosense-sdk/hostProvidedStyles.css');
// The one sheet that must survive: the aggregate `@faclon-labs/design-sdk/styles.css`
// (dist/style.css), imported deliberately by the dev-only entry so the harness stands
// in for the host. `find dist -name style.css` matches exactly one file and no module
// inside the package imports it — components import their own per-component sheets —
// so keying on the basename cannot let SDK CSS (Chart.css, styles/global.css, …) back
// into a widget bundle.
const isSdkAggregateSheet = (request) => {
  const req = String(request || '');
  // Loader-prefixed requests ("!!../../../css-loader/dist/cjs.js!./style.css")
  // carry the real resource after the last "!".
  return /(^|[/.])style\.css$/.test(req.slice(req.lastIndexOf('!') + 1));
};

const COMPONENTS = {
  TableWidget: './src/components/TableWidget/index.ts',
  TableWidgetConfiguration: './src/components/TableWidgetConfiguration/index.ts',
};

export default (env, argv) => {
  const isProd = argv.mode === 'production';

  return {
    mode: isProd ? 'production' : 'development',
    entry: isProd ? COMPONENTS : { app: './src/index.tsx' },
    output: {
      path: path.resolve(__dirname, isProd ? 'dist-bundle' : 'dist'),
      filename: isProd ? '[name].bundle.js' : '[name].js',
      globalObject: 'this',
      clean: true,
    },
    externals: isProd
      ? {
          react: 'React',
          'react-dom': 'ReactDOM',
          'react-dom/client': 'ReactDOM',
          'react-dom/server': 'ReactDOMServer',
          'react/jsx-runtime': 'ReactJSXRuntime',
          'react/jsx-dev-runtime': 'ReactJSXRuntime',
        }
      : {},
    resolve: { extensions: ['.tsx', '.ts', '.js'] },
    module: {
      rules: [
        {
          test: /\.m?js$/,
          resolve: { fullySpecified: false },
        },
        {
          test: /\.(ts|tsx)$/,
          exclude: /node_modules/,
          use: {
            loader: 'babel-loader',
            options: {
              presets: [
                '@babel/preset-env',
                ['@babel/preset-react', { runtime: 'automatic' }],
                '@babel/preset-typescript',
              ],
            },
          },
        },
        {
          test: /\.css$/,
          use: [
            isProd ? MiniCssExtractPlugin.loader : 'style-loader',
            'css-loader',
          ],
        },
        {
          test: /\.(png|jpg|jpeg|gif|webp|svg)$/i,
          type: 'asset/resource',
          generator: { filename: 'assets/[name][ext]' },
        },
      ],
    },
    plugins: [
      // Matches on resource.context (the *importer's* directory), not the
      // request string — that confines it to imports made from inside the
      // package. Applied in dev too, so the harness exercises the same
      // single-sheet arrangement as prod.
      //
      // The aggregate sheet needs an explicit exemption: style-loader and
      // mini-css-extract re-request every stylesheet through css-loader as a
      // child module whose context is the *stylesheet's own* directory. For
      // src/index.tsx's `@faclon-labs/design-sdk/styles.css` that child context
      // is design-sdk/dist, so the context test alone would swallow the very
      // import the dev harness depends on and render it unstyled.
      new webpack.NormalModuleReplacementPlugin(/\.css$/, (resource) => {
        if (isSdkAggregateSheet(resource.request)) return;
        if ((resource.context || '').includes(DESIGN_SDK_DIR)) {
          resource.request = HOST_PROVIDED_STYLES;
        }
      }),
      ...(isProd ? [new MiniCssExtractPlugin({ filename: '[name].bundle.css' })] : []),
    ],
    ...(!isProd && {
      devServer: {
        static: path.resolve(__dirname, 'public'),
        port: 3000,
        hot: true,
        open: false,
        historyApiFallback: true,
      },
    }),
  };
};
