-- Goal judging is removed: conversation goals are custom metrics now (the
-- ao_judges registry). The tag-based goal analyzer's claim table goes with it.
-- Historical goal verdicts in ao_session_external_evals (source='goal' and the
-- eval sweeper's judge_name 'goal:*' rows) are kept as readable history.
DROP TABLE IF EXISTS ao_session_goal_analyses;
