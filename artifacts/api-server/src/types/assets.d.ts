// Ambient declarations for binary assets imported as base64 strings via the
// esbuild `.ttf` base64 loader (see build.mjs). Lets the invoice PDF generator
// `import robotoRegular from "../assets/fonts/Roboto-Regular.ttf"` type-check.
declare module "*.ttf" {
  const content: string;
  export default content;
}
