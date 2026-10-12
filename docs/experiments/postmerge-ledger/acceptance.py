from pathlib import Path
import csv,hashlib,json,os,sqlite3,subprocess,sys,tempfile,unittest
WS=Path(os.environ['RC_APP_WORKSPACE'])
class Acceptance(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.db=self.root/'ledger.sqlite3'
    def call(self,*args,ok=True,parse=True,db=None):
        env={**os.environ,'PYTHONPATH':str(WS),'PYTHONDONTWRITEBYTECODE':'1'}
        p=subprocess.run(['python3.13','-m','ledger_app','--data',str(db or self.db),*map(str,args)],cwd=WS,env=env,capture_output=True,text=True,timeout=20)
        if ok:
            self.assertEqual(p.returncode,0,p.stdout+p.stderr);self.assertEqual(p.stderr,'')
            return json.loads(p.stdout) if parse else p
        self.assertNotEqual(p.returncode,0,p.stdout+p.stderr);self.assertTrue(p.stderr.strip())
        return p
    def add(self,kind='income',amount='10.00',category='工作',date='2026-10-10',note=''):
        return self.call('add','--kind',kind,'--amount',amount,'--category',category,'--date',date,'--note',note)
    def fixture(self):
        a=self.add('income','100.00','工作','2026-10-01','收入');b=self.add('expense','12.50','餐饮','2026-10-02','午餐');c=self.add('expense','2.05','交通','2026-10-03','地铁');return a,b,c
    def bytes_error(self,*args,db=None):
        file=db or self.db;before=file.read_bytes();p=self.call(*args,db=file,ok=False);self.assertEqual(before,file.read_bytes());return p
    def test_01_help_no_database(self):
        p=self.call('--help',parse=False);self.assertIn('usage',p.stdout.lower());self.assertFalse(self.db.exists())
    def test_02_empty_reads_no_database(self):
        self.assertEqual(self.call('list'),[]);self.assertEqual(self.call('summary'),{'income_cents':0,'expense_cents':0,'balance_cents':0,'count':0});self.assertFalse(self.db.exists())
    def test_03_add_fields_and_restart(self):
        row=self.add('income','13.05',' 工作 ','2026-10-10','备注中文');self.assertGreater(row['id'],0);self.assertIs(type(row['amount_cents']),int);self.assertEqual(row['amount_cents'],1305)
        self.assertEqual(row['category'],'工作');self.assertEqual(row['kind'],'income');self.assertEqual(row['date'],'2026-10-10');self.assertEqual(row['note'],'备注中文');self.assertEqual(self.call('list'),[row])
    def test_04_invalid_amounts_no_initial_write(self):
        for amount in ['0','-1','1.001','1e2','NaN','Infinity']:
            with self.subTest(amount=amount):
                self.call('add','--kind','income','--amount',amount,'--category','A','--date','2026-10-01',ok=False);self.assertFalse(self.db.exists())
    def test_05_invalid_date_category_kind(self):
        self.add();before=self.db.read_bytes()
        for date in ['2026-02-30','2026-2-01','not-a-date']:
            with self.subTest(date=date):self.call('add','--kind','expense','--amount','1','--category','A','--date',date,ok=False)
        self.call('add','--kind','income','--amount','1','--category','  ','--date','2026-10-01',ok=False)
        self.call('add','--kind','transfer','--amount','1','--category','A','--date','2026-10-01',ok=False);self.assertEqual(before,self.db.read_bytes())
    def test_06_and_filters(self):
        a,b,c=self.fixture();self.assertEqual(self.call('list','--kind','expense','--category','餐饮','--from','2026-10-02','--to','2026-10-02'),[b]);self.assertEqual(self.call('list','--kind','income','--category','餐饮'),[])
    def test_07_sort_date_id(self):
        x=self.add(date='2026-10-03');y=self.add(date='2026-10-01');z=self.add(date='2026-10-01');self.assertEqual([r['id'] for r in self.call('list')],[y['id'],z['id'],x['id']])
    def test_08_invalid_range_no_write(self):
        self.fixture();self.bytes_error('list','--from','2026-10-03','--to','2026-10-01');self.bytes_error('summary','--from','bad-date')
    def test_09_summary_exact(self):
        self.fixture();self.assertEqual(self.call('summary'),{'income_cents':10000,'expense_cents':1455,'balance_cents':8545,'count':3});self.assertEqual(self.call('summary','--from','2026-10-02','--to','2026-10-03'),{'income_cents':0,'expense_cents':1455,'balance_cents':-1455,'count':2})
    def test_10_delete_persistence_and_ids(self):
        a,b,c=self.fixture();self.assertEqual(self.call('delete',c['id']),{'id':c['id'],'deleted':True});d=self.add();self.assertGreater(d['id'],c['id']);self.assertNotIn(c['id'],[r['id'] for r in self.call('list')])
    def test_11_unknown_delete_no_change(self):
        self.add();
        for value in ['999','0','-1','abc']:self.bytes_error('delete',value)
    def test_12_csv_roundtrip(self):
        note='中文,含"引号"\n第二行';row=self.add(note=note);out=self.root/'ledger.csv';before=self.db.read_bytes();result=self.call('export','--output',out);self.assertEqual(result['count'],1);self.assertEqual(Path(result['output']).resolve(),out.resolve());self.assertEqual(before,self.db.read_bytes());self.assertTrue(out.read_bytes().startswith(b'\xef\xbb\xbf'))
        with out.open(encoding='utf-8-sig',newline='') as f:rows=list(csv.DictReader(f))
        self.assertEqual(list(rows[0]),['id','kind','amount_cents','category','date','note']);self.assertEqual(rows[0]['note'],note);self.assertEqual(rows[0]['amount_cents'],'1000')
    def test_13_empty_csv_header(self):
        out=self.root/'empty.csv';r=self.call('export','--output',out);self.assertEqual(r['count'],0)
        with out.open(encoding='utf-8-sig',newline='') as f:self.assertEqual(list(csv.reader(f)),[['id','kind','amount_cents','category','date','note']])
    def test_14_export_same_database(self):
        self.add();self.bytes_error('export','--output',self.db)
    def test_15_export_database_aliases(self):
        self.add();sym=self.root/'sym.csv';sym.symlink_to(self.db);hard=self.root/'hard.csv';os.link(self.db,hard)
        for out in [sym,hard]:
            with self.subTest(path=out):self.bytes_error('export','--output',out)
    def test_16_export_missing_parent(self):
        self.add();self.bytes_error('export','--output',self.root/'missing/out.csv')
    def test_17_corrupt_database_preserved(self):
        self.db.write_bytes(b'not a sqlite database; preserve me')
        for args in [('list',),('add','--kind','income','--amount','1','--category','A','--date','2026-10-01')]:
            p=self.bytes_error(*args);self.assertIn(self.db.name,p.stderr);self.assertIn(str(self.root).replace('/private/var/','/var/'),p.stderr.replace('/private/var/','/var/'))
    def test_18_foreign_database_preserved(self):
        with sqlite3.connect(self.db) as c:c.execute('CREATE TABLE unrelated(value TEXT)');c.execute('PRAGMA user_version=99');c.commit()
        p=self.bytes_error('list');self.assertIn(self.db.name,p.stderr)
    def test_19_read_does_not_modify(self):
        self.fixture();before=self.db.read_bytes();self.call('list');self.call('summary');self.assertEqual(before,self.db.read_bytes())
if __name__=='__main__':unittest.main(verbosity=2)
