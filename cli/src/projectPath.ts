import { dirname, resolve, join, basename } from 'path';
import { fileURLToPath } from 'url';
import { configuration } from '@/configuration';
import packageJson from '../package.json';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Bun embeds compiled code in a virtual filesystem: /$bunfs/ (Linux/macOS) or /~BUN/ (Windows) */
const bunMain = globalThis.Bun?.main ?? '';
const execBase = basename(process.execPath).toLowerCase();
const isBunExecutable = execBase === 'bun' || execBase === 'bun.exe';
const isCompiled = !isBunExecutable && (bunMain.includes('$bunfs') || bunMain.includes('/~BUN/'));

export function projectPath(): string {
    return resolve(__dirname, '..');
}

export function runtimePath(): string {
    if (!isCompiled) {
        return projectPath();
    }

    return join(configuration.happyHomeDir, 'runtime', packageJson.version);
}

export function isBunCompiled(): boolean {
    return isCompiled;
}
