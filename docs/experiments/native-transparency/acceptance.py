from pathlib import Path
import unittest,subprocess,tempfile,json,os,csv,io
WORKSPACE=Path(os.environ['RC_APP_WORKSPACE'])
class Acceptance(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name);self.data=self.root/'notes.json'
 def call(self,*args,ok=True):
  p=subprocess.run(['python3.13','-m','notes_app','--data',str(self.data),'--json',*map(str,args)],cwd=WORKSPACE,capture_output=True,text=True,timeout=30)
  if ok:self.assertEqual(p.returncode,0,p.stderr)
  else:self.assertNotEqual(p.returncode,0);return p
  return json.loads(p.stdout) if p.stdout.strip() else None
 def add(self,title='中文标题',body='正文'):
  return self.call('add','--title',title,'--body',body)
 def test_01_persistence_and_fields(self):
  n=self.add();self.assertIsInstance(n['id'],int);self.assertGreater(n['id'],0);self.assertEqual(n['title'],'中文标题');self.assertEqual(n['body'],'正文');self.assertTrue(n['created_at']);self.assertEqual(self.call('show',n['id']),n)
 def test_02_sorted_list_and_search(self):
  a=self.add('Alpha','中文正文');b=self.add('Beta','other');self.assertEqual([x['id'] for x in self.call('list')],[a['id'],b['id']]);self.assertEqual([x['id'] for x in self.call('list','--query','ALPHA')],[a['id']]);self.assertEqual([x['id'] for x in self.call('list','--query','中文')],[a['id']]);self.assertEqual(self.call('list','--query','not-present'),[])
 def test_03_edit_preserves_omitted_fields(self):
  a=self.add();b=self.call('edit',a['id'],'--title','新标题');self.assertEqual(b['title'],'新标题');self.assertEqual(b['body'],a['body']);self.assertEqual(b['created_at'],a['created_at'])
 def test_04_delete_and_no_id_reuse(self):
  a=self.add();self.call('delete',a['id']);b=self.add();self.assertGreater(b['id'],a['id']);self.call('show',a['id'],ok=False)
 def test_05_empty_title_rejected_atomically(self):
  self.add();before=self.data.read_bytes();self.call('add','--title','   ','--body','bad',ok=False);self.assertEqual(self.data.read_bytes(),before)
 def test_06_unknown_id_rejected_atomically(self):
  self.add();before=self.data.read_bytes()
  for args in [('show','9999'),('edit','9999','--body','bad'),('delete','9999')]:
   self.call(*args,ok=False);self.assertEqual(self.data.read_bytes(),before)
 def test_07_corrupt_data_preserved(self):
  self.data.write_bytes(b'{ broken input');before=self.data.read_bytes();p=self.call('list',ok=False);self.assertEqual(self.data.read_bytes(),before);self.assertIn(str(self.data),p.stdout+p.stderr);self.assertNotIn('Traceback',p.stdout+p.stderr)
 def test_08_incompatible_data_preserved(self):
  self.data.write_text(json.dumps({'unrelated':'structure'}));before=self.data.read_bytes();self.call('list',ok=False);self.assertEqual(self.data.read_bytes(),before)
 def test_09_csv_round_trip(self):
  n=self.add('中,"文','line1\nline2,"quoted"');out=self.root/'notes.csv';self.call('export','--out',out);self.assertTrue(out.read_bytes().startswith(b'\xef\xbb\xbf'));rows=list(csv.DictReader(io.StringIO(out.read_text(encoding='utf-8-sig'))));self.assertEqual(list(rows[0]),['id','title','body','created_at']);self.assertEqual(rows[0]['title'],n['title']);self.assertEqual(rows[0]['body'],n['body'])
 def test_10_export_same_path_protected(self):
  self.add();before=self.data.read_bytes();self.call('export','--out',self.data,ok=False);self.assertEqual(self.data.read_bytes(),before)
 def test_11_export_symlink_protected(self):
  self.add();before=self.data.read_bytes();alias=self.root/'alias.csv';alias.symlink_to(self.data);self.call('export','--out',alias,ok=False);self.assertEqual(self.data.read_bytes(),before)
 def test_12_export_hardlink_protected(self):
  self.add();before=self.data.read_bytes();alias=self.root/'alias.csv';os.link(self.data,alias);self.call('export','--out',alias,ok=False);self.assertEqual(self.data.read_bytes(),before)
 def test_13_queries_do_not_write(self):
  n=self.add();before=self.data.read_bytes();mtime=self.data.stat().st_mtime_ns;self.call('list');self.call('show',n['id']);self.assertEqual(self.data.read_bytes(),before);self.assertEqual(self.data.stat().st_mtime_ns,mtime)
 def test_14_help_does_not_create_data(self):
  p=subprocess.run(['python3.13','-m','notes_app','--data',str(self.data),'--help'],cwd=WORKSPACE,capture_output=True,text=True,timeout=30);self.assertEqual(p.returncode,0);self.assertFalse(self.data.exists())
if __name__=='__main__':unittest.main(verbosity=2)
