from pathlib import Path
import os,subprocess,unittest
ROOT=Path(os.environ['RC_APP_WORKSPACE'])
class Acceptance(unittest.TestCase):
    def call(self,*args):
        return subprocess.run(['python3.13',str(ROOT/'mini_app.py'),*args],capture_output=True,text=True,timeout=10,cwd=ROOT)
    def test_R01_ready(self):
        p=self.call();self.assertEqual(p.returncode,0,p.stderr);self.assertEqual(p.stdout,'READY\n');self.assertEqual(p.stderr,'')
    def test_R02_help(self):
        p=self.call('--help');self.assertEqual(p.returncode,0,p.stderr);self.assertIn('usage',p.stdout.lower())
if __name__=='__main__':unittest.main(verbosity=2)
