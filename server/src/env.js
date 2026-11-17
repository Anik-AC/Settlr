import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load the repo-root .env (e.g. OPENROUTER_API_KEY) before anything reads process.env.
// Real environment variables win over the file.
const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env');
if (fs.existsSync(file)) process.loadEnvFile(file);
