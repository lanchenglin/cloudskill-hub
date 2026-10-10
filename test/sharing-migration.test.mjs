import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';

test('sharing migration preserves legacy credentials and keeps unknown/private history private',()=>{
  const db=new DatabaseSync(':memory:');try{
    for(const f of ['0001_initial.sql','0002_binary_uploads.sql','0003_web_auth.sql','0004_require_password_change.sql'])db.exec(readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));
    db.exec("INSERT INTO access_tokens(id,label,token_hash,role,project_scope,created_at,can_publish,expires_at) VALUES('old-reader','Old reader','unique-old-hash','client','[\"personal\"]','2025-01-01',0,'2027-01-01')");
    db.exec("INSERT INTO projects VALUES('personal','Personal','2025-01-01')");
    db.exec("INSERT INTO skills VALUES('personal','was-public','Visible latest',2,'public','2025-01-01'),('personal','always-private','Private',1,'private','2025-01-01')");
    const insert=db.prepare("INSERT INTO skill_versions(project_slug,slug,version,artifact_digest,archive_digest,artifact_key,archive_key,file_names,created_at) VALUES('personal',?,?,'digest','archive-digest','artifact-key','archive-key','[\"SKILL.md\"]','2025-01-01')");
    insert.run('was-public',1);insert.run('was-public',2);insert.run('always-private',1);
    db.exec(readFileSync(new URL('../migrations/0005_sharing_permissions.sql',import.meta.url),'utf8'));
    const token=db.prepare('SELECT * FROM access_tokens').get();assert.equal(token.permission_mode,'legacy');assert.equal(token.can_publish,0);assert.equal(token.role,'client');assert.equal(token.project_scope,'["personal"]');assert.equal(token.expires_at,'2027-01-01');assert.equal(token.revoked_at,null);
    const versions=db.prepare('SELECT slug,version,published_visibility FROM skill_versions ORDER BY slug,version').all();
    assert.deepEqual(versions.map(v=>[v.slug,v.version,v.published_visibility]),[['always-private',1,'private'],['was-public',1,'private'],['was-public',2,'public']]);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{db.close();}
});
