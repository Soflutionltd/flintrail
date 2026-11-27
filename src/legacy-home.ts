// Imported first by the programs (the command, the native host), before the configuration is read: the folder
// an install from before the rename left is moved once (src/legacy.ts). A library use or a test never moves it.
import { adoptHome } from './legacy.js';

adoptHome();
