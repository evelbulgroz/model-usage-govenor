/**
 * Package root entrypoint barrel re-exporting the public governor facade.
 */
export {
	assertStrictModeSchemaCompleteness,
	assessReservation,
	executeOperation,
	validateSchemaDefinition,
	type ExecuteOperationOptions,
	type GovernorOptions,
	type GovernorResult,
	type StructuredOutputSchema,
} from './governor/governor.ts';
