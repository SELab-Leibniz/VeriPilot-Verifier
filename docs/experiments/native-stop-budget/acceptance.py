"""Independent original Todo T01-T22 acceptance through real CLI and JSON bytes."""
from pathlib import Path
import csv, json, os, subprocess, sys, tempfile, unittest
WS = Path(os.environ['RC_APP_WORKSPACE'])
CLI = WS / 'rc-python-todo-demo/todo.py'
class Acceptance(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.data = self.root / 'todos.json'
    def call(self, *args, data=None, ok=True):
        p = subprocess.run([sys.executable, str(CLI), '--data', str(data or self.data), *map(str,args)], capture_output=True, text=True, timeout=30, cwd=self.root)
        if ok: self.assertEqual(p.returncode,0,p.stdout+p.stderr)
        else: self.assertNotEqual(p.returncode,0,p.stdout+p.stderr)
        return p
    def read(self): return json.loads(self.data.read_text())
    def add(self,title='测试任务',priority='medium',tags=''):
        self.call('add',title,'--priority',priority,'--tags',tags)
        return self.read()['todos'][-1]['id']
    def unchanged_error(self,*args):
        before=self.data.read_bytes(); p=self.call(*args,ok=False)
        self.assertEqual(before,self.data.read_bytes()); self.assertTrue((p.stdout+p.stderr).strip())
        return p
    def test_T01_normal_add(self):
        self.add(); r=self.read()['todos'][0]
        self.assertEqual(r['title'],'测试任务'); self.assertEqual(r['priority'],'medium'); self.assertFalse(r['completed'])
        self.assertEqual(r['id'],1); self.assertEqual(r['tags'],[])
    def test_T02_empty_titles(self):
        self.call('add','',ok=False); self.call('add','   \t',ok=False); self.assertFalse(self.data.exists())
    def test_T03_stable_ids(self):
        a=self.add('A'); b=self.add('B'); self.call('delete',b); c=self.add('C'); self.assertEqual([a,b,c],[1,2,3])
    def test_T04_bad_priority(self): self.call('add','A','--priority','urgent',ok=False); self.assertFalse(self.data.exists())
    def fixture(self):
        a=self.add('ALPHA_X','high','工作, 报告,工作,, '); b=self.add('BETA_Y','low','家庭'); self.call('done',a)
        self.assertEqual(self.read()['todos'][0]['tags'],['工作','报告']); return a,b
    def test_T05_status(self):
        self.fixture(); p=self.call('list','--status','completed'); self.assertIn('ALPHA_X',p.stdout); self.assertNotIn('BETA_Y',p.stdout)
        p=self.call('list','--status','pending'); self.assertIn('BETA_Y',p.stdout); self.assertNotIn('ALPHA_X',p.stdout)
    def test_T06_priority(self):
        self.fixture(); p=self.call('list','--priority','high'); self.assertIn('ALPHA_X',p.stdout); self.assertNotIn('BETA_Y',p.stdout)
    def test_T07_tag(self):
        self.fixture(); p=self.call('list','--tag','工作'); self.assertIn('ALPHA_X',p.stdout); self.assertNotIn('BETA_Y',p.stdout)
    def test_T08_and(self):
        self.fixture(); p=self.call('list','--status','completed','--priority','high','--tag','工作'); self.assertIn('ALPHA_X',p.stdout); self.assertNotIn('BETA_Y',p.stdout)
        p=self.call('list','--status','pending','--priority','high','--tag','工作'); self.assertNotIn('ALPHA_X',p.stdout); self.assertTrue(p.stdout.strip())
    def test_T09_toggle(self):
        a=self.add(); self.call('done',a); self.assertTrue(self.read()['todos'][0]['completed']); self.call('undone',a); self.assertFalse(self.read()['todos'][0]['completed'])
    def test_T10_idempotent(self):
        a=self.add(); self.call('done',a); before=self.data.read_bytes(); self.call('done',a); self.assertEqual(before,self.data.read_bytes())
        self.call('undone',a); before=self.data.read_bytes(); self.call('undone',a); self.assertEqual(before,self.data.read_bytes())
    def test_T11_delete(self):
        a=self.add(); self.call('delete',a); self.assertEqual(self.read()['todos'],[])
    def test_T12_cross_process_delete(self):
        a=self.add('REMOVED_X'); self.call('delete',a); self.assertNotIn('REMOVED_X',self.call('list').stdout); self.assertEqual(self.read()['todos'],[])
    def test_T13_unknown_id(self):
        self.add();
        for cmd in ['done','undone','delete']: self.unchanged_error(cmd,999)
    def test_T14_stats(self):
        self.fixture(); self.add('GAMMA_Z'); p=self.call('stats'); self.assertTrue(p.stdout.strip())
        # Verify displayed numbers independent of language labels; distributions 3,1,2,1,1,1.
        import re
        numbers=[int(x) for x in re.findall(r'(?<!\w)\d+(?!\w)',p.stdout)]
        self.assertEqual(sorted(numbers),[1,1,1,1,2,3],p.stdout)
    def test_T15_empty_stats(self):
        import re
        p=self.call('stats'); numbers=re.findall(r'(?<!\w)\d+(?!\w)',p.stdout)
        self.assertEqual(numbers,['0']*6,p.stdout); self.assertFalse(self.data.exists())
    def test_T16_csv_roundtrip(self):
        title='中文,含"引号"\n第二行'; self.add(title,'high','工作,报告'); out=self.root/'out.csv'; self.call('export','--output',out)
        with out.open(encoding='utf-8-sig',newline='') as f: rows=list(csv.DictReader(f))
        self.assertEqual(list(rows[0]),['id','title','priority','tags','completed']); self.assertEqual(rows[0]['title'],title)
        self.assertEqual(rows[0]['tags'],'工作,报告'); self.assertEqual(rows[0]['completed'],'false')
    def test_T17_empty_csv(self):
        out=self.root/'out.csv'; self.call('export','--output',out)
        with out.open(encoding='utf-8-sig',newline='') as f: self.assertEqual(list(csv.reader(f)),[['id','title','priority','tags','completed']])
    def corrupted(self,raw):
        self.data.write_bytes(raw); p=self.unchanged_error('list'); self.assertIn(str(self.data),p.stdout+p.stderr)
        self.unchanged_error('add','Do not overwrite')
    def test_T18_json_syntax(self): self.corrupted(b'{ broken json')
    def test_T19_structural_validation(self):
        row={'id':1,'title':'A','priority':'medium','tags':[],'completed':False}
        bad=[[],{}, {'next_id':2,'todos':[row,row]}, {'next_id':1,'todos':[row]}, {'next_id':2,'todos':[dict(row,id=True)]}, {'next_id':2,'todos':[dict(row,completed='false')]}, {'next_id':2,'todos':[dict(row,tags='work')]}, {'next_id':2,'todos':[dict(row,title='   ')]}]
        for data in bad:
            with self.subTest(data=data): self.corrupted(json.dumps(data).encode())
    def test_T20_restart(self):
        a=self.add('RESTART_X'); self.call('done',a); self.assertIn('RESTART_X',self.call('list','--status','completed').stdout)
        self.assertTrue(self.read()['todos'][0]['completed']); self.assertEqual(self.add('Second'),a+1)
    def test_T21_export_preserves_data(self):
        self.add(); before=self.data.read_bytes(); self.call('export','--output',self.root/'out.csv'); self.assertEqual(before,self.data.read_bytes())
        self.unchanged_error('export','--output',self.data)
        self.unchanged_error('export','--output',self.root/'missing/out.csv')
    def test_T22_help_and_arguments(self):
        for cmd in [[],['add'],['list'],['done'],['undone'],['delete'],['stats'],['export']]:
            p=subprocess.run([sys.executable,str(CLI),*cmd,'--help'],capture_output=True,text=True,timeout=30,cwd=self.root)
            self.assertEqual(p.returncode,0,p.stdout+p.stderr); self.assertTrue(p.stdout.strip())
        self.call('badcommand',ok=False); self.call('done','abc',ok=False); self.assertFalse(self.data.exists())
if __name__=='__main__': unittest.main(verbosity=2)
