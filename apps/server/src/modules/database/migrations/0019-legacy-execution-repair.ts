/** Legacy claims consumed comments before success. Missing snapshot evidence keeps its lock. */
export const LEGACY_EXECUTION_REPAIR_SQL = `
UPDATE comments SET executed_at = NULL
WHERE executed_at IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM jobs, json_each(jobs.work_context_json, '$.commentSnapshot') snapshot
    WHERE jobs.task_id = comments.task_id AND jobs.kind != 'cancel'
      AND jobs.status != 'succeeded'
      AND snapshot.type = 'object'
      AND json_extract(CASE WHEN snapshot.type = 'object' THEN snapshot.value ELSE '{}' END, '$.id') = comments.id
      AND json_extract(CASE WHEN snapshot.type = 'object' THEN snapshot.value ELSE '{}' END, '$.version') = comments.version
  )
  AND NOT EXISTS (
    SELECT 1 FROM jobs, json_each(jobs.work_context_json, '$.commentSnapshot') snapshot
    WHERE jobs.task_id = comments.task_id AND jobs.kind != 'cancel'
      AND jobs.status = 'succeeded'
      AND snapshot.type = 'object'
      AND json_extract(CASE WHEN snapshot.type = 'object' THEN snapshot.value ELSE '{}' END, '$.id') = comments.id
      AND json_extract(CASE WHEN snapshot.type = 'object' THEN snapshot.value ELSE '{}' END, '$.version') = comments.version
  );

-- Keep old prompt URLs byte-for-byte valid while retaining their vault object.
-- Original IDs can occur in several old jobs; task ownership is identical.
INSERT OR IGNORE INTO job_attachment_snapshots (
  id, job_id, task_id, original_attachment_id, comment_id, uploader_id,
  filename, content_type, size_bytes, sha256, storage_key, created_at
)
SELECT attachments.id, jobs.id, jobs.task_id, attachments.id, attachments.comment_id,
  attachments.uploader_id, attachments.filename, attachments.content_type,
  attachments.size_bytes, attachments.sha256, attachments.storage_key, attachments.created_at
FROM jobs, json_each(jobs.work_context_json, '$.attachmentSnapshot') snapshot
JOIN attachments ON attachments.id = json_extract(CASE WHEN snapshot.type = 'object' THEN snapshot.value ELSE '{}' END, '$.id')
  AND attachments.task_id = jobs.task_id
WHERE jobs.kind != 'cancel' AND snapshot.type = 'object'
  AND json_extract(CASE WHEN snapshot.type = 'object' THEN snapshot.value ELSE '{}' END, '$.originalAttachmentId') IS NULL
ORDER BY jobs.queued_at, jobs.id;

-- Removed legacy bytes cannot be reconstructed. Prevent an automatic partial dispatch.
UPDATE jobs SET status = 'failed_recoverable',
  error_code = 'LEGACY_ATTACHMENT_SNAPSHOT_MISSING',
  error_summary = '历史附件快照已缺失，请补充附件后重新提交作业',
  lease_owner = NULL, lease_expires_at = NULL,
  completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE kind != 'cancel' AND status = 'queued' AND EXISTS (
  SELECT 1 FROM json_each(jobs.work_context_json, '$.attachmentSnapshot') snapshot
  WHERE snapshot.type = 'object'
    AND json_extract(CASE WHEN snapshot.type = 'object' THEN snapshot.value ELSE '{}' END, '$.originalAttachmentId') IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM job_attachment_snapshots saved
      WHERE saved.id = json_extract(CASE WHEN snapshot.type = 'object' THEN snapshot.value ELSE '{}' END, '$.id') AND saved.task_id = jobs.task_id
    )
);
`;
