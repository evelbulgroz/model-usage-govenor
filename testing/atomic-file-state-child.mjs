import fs from 'node:fs';
import { durableReplaceSync } from '../atomic-file-state.ts';

const [targetFile] = process.argv.slice(2);
const injectedFs = Object.assign(Object.create(fs), {
	renameSync(source, target) {
		fs.renameSync(source, target);
		process.kill(process.pid, 'SIGKILL');
	},
});

durableReplaceSync(targetFile, '{"state":"new"}\n', {
	mode: 0o600,
	dependencies: { fs: injectedFs },
});
