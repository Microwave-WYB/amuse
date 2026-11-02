-- The right password signs any device in (#85): no device waits for another's approval any more. The devices that were
-- waiting are forgotten (they had no session, and the password brings them back); every one kept is trusted, so neither
-- `trusted` nor `asked` (when a waiting device last asked) says anything now. Sessions are untouched.

-- migrate:up

delete from devices where trusted = 0;
alter table devices drop column asked;
alter table devices drop column trusted;

-- migrate:down

alter table devices add column trusted integer not null default 1 check (trusted in (0, 1));
alter table devices add column asked text;
