"""Run the sample's unittest suite and save its actual output and exit code."""
import io
from pathlib import Path
import sys
import unittest

suite = unittest.defaultTestLoader.discover('.', pattern='test_*.py')
output = io.StringIO()
result = unittest.TextTestRunner(stream=output, verbosity=2).run(suite)
exit_code = 0 if result.testsRun > 0 and result.wasSuccessful() else 1
text = output.getvalue() + f'\nEXIT_CODE={exit_code}\n'
Path('test-output.txt').write_text(text, encoding='utf-8')
print(text, end='')
sys.exit(exit_code)
