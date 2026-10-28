import { ModelUsageError } from '../policy/errors.ts';

export class CopilotModelAdapter {
	readonly routeId: string;

	constructor(route: { id: string } = { id: 'copilot-external' }) {
		this.routeId = route.id;
		throw new ModelUsageError(
			'ERR_ALL_ALLOWED_ROUTES_EXHAUSTED',
			'Copilot hosted or CLI usage is external best-effort and is not a governed transport',
			{ routeId: route.id, reason: 'external-best-effort' },
		);
	}
}
