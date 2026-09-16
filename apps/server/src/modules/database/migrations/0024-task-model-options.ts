export const TASK_MODEL_OPTIONS_SQL = `
ALTER TABLE task_threads ADD COLUMN model_options_json TEXT;
`;
