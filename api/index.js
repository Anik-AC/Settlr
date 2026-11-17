// Vercel serverless entry: every /api/* request is rewritten here (see vercel.json).
// The React app is served by Vercel as static files from client/dist.
import { createApp, handleErrors } from '../server/src/app.js';

export default handleErrors(createApp());
