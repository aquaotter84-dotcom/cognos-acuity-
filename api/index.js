// Vercel serverless entrypoint. Express apps are valid Node request handlers,
// so Vercel can invoke the app directly. vercel.json routes every /api/* path
// here; the SPA is served from the static build by the CDN.
export { default } from "../server/index.js";
