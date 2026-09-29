-- D28 follow-up (2026-09-30): more rc words that hid the keyword block in live tests on the two live
-- job landing pages (hospital + packing), rc passed as `?rc=` exactly like a paid click. Terms are
-- stored normalized (lowercase, plural-folded — "Openings" → "opening").
-- Same test round, words that SHOWED the block (not blocked): Naukri, Bharti, Duty, Kaam (both pages);
-- Work (hospital only). "patient care assistant" hid it 3/3 but isn't added: as a phrase it would also
-- block "Patient care assistant course fees", which showed.
INSERT INTO "rc_blocked_terms" ("id", "term", "source", "status", "note", "updated_at") VALUES
  (gen_random_uuid(), 'opportunity', 'SEED', 'BLOCKED', 'Live test 2026-09-30: "Hospital Opportunity", "Hospital Opportunities", "packing Opportunity", "Packing Opportunities" all hid the keyword block. Tested on job pages only — Allow it if another vertical needs it.', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'recruitment', 'SEED', 'BLOCKED', 'Live test 2026-09-30: "Hospital Recruitment" hid the keyword block on a job page.', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'employment', 'SEED', 'BLOCKED', 'Live test 2026-09-30: "Hospital Employment" hid the keyword block on a job page.', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'opening', 'SEED', 'BLOCKED', 'Live test 2026-09-30: "Hospital Openings" hid the keyword block on a job page. Tested on job pages only — Allow it if another vertical needs it.', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'salary', 'SEED', 'BLOCKED', 'Live test 2026-09-30: "Hospital Salary" hid the keyword block on a job page. Tested on job pages only — Allow it if a loan/finance rc needs it.', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'staff required', 'SEED', 'BLOCKED', 'Live test 2026-09-30: "Hospital Staff Required" hid the keyword block on a job page.', CURRENT_TIMESTAMP)
ON CONFLICT ("term") DO NOTHING;
