import copy
import importlib.util
import json
from pathlib import Path
import unittest

from production import CONFIG, ROOT

spec = importlib.util.spec_from_file_location('restore_drill', Path(__file__).with_name('restore-drill.py'))
restore = importlib.util.module_from_spec(spec)
spec.loader.exec_module(restore)


class RestoreGuardTests(unittest.TestCase):
    def setUp(self):
        self.current = json.loads(CONFIG.read_text())
        self.target = copy.deepcopy(self.current)
        self.target.update(name='etymology-feed-restore-test', main='src/restore.ts', routes=[], triggers={'crons': []})
        self.target['assets'].update(binding='ASSETS', run_worker_first=True)
        self.target['vars'].pop('BETTER_AUTH_URL')
        self.target['d1_databases'][1]['database_id'] = 'fresh-app'
        self.target['kv_namespaces'] = [{'binding': 'CACHE', 'id': 'fresh-cache'}]
        self.manifest = {'app': self.current['d1_databases'][1], 'dictionary': {
            'database_id': self.current['d1_databases'][0]['database_id'],
            'release': self.current['vars']['DICT_RELEASE'],
        }}

    def validate(self):
        return restore.validate_target(self.current, self.target, ROOT / 'apps/api/.restore-test.json', self.manifest)

    def test_isolated_guarded_config_passes(self):
        self.assertEqual(self.validate(), 'fresh-app')

    def test_unguarded_entrypoint_assets_and_routes_are_rejected(self):
        for field, value in [('main', 'src/index.ts'), ('route', 'etymologyfeed.com/*')]:
            with self.subTest(field=field):
                target = copy.deepcopy(self.target)
                self.target[field] = value
                with self.assertRaises(ValueError):
                    self.validate()
                self.target = target
        self.target['assets']['run_worker_first'] = ['/api/*']
        with self.assertRaisesRegex(ValueError, 'access-gated'):
            self.validate()

    def test_reusing_cache_with_different_metadata_is_rejected(self):
        self.target['kv_namespaces'][0].update(id=self.current['kv_namespaces'][0]['id'], preview_id='different')
        with self.assertRaisesRegex(ValueError, 'isolate'):
            self.validate()

    def test_production_or_backup_databases_cannot_be_restore_targets(self):
        for database in self.current['d1_databases']:
            self.target['d1_databases'][1]['database_id'] = database['database_id']
            with self.assertRaisesRegex(ValueError, 'isolate'):
                self.validate()
        self.target['d1_databases'].append(copy.deepcopy(self.current['d1_databases'][1]))
        with self.assertRaisesRegex(ValueError, 'exactly one'):
            self.validate()

    def test_dictionary_and_account_must_match(self):
        self.target['vars']['DICT_RELEASE'] = 'wrong-release'
        with self.assertRaisesRegex(ValueError, 'manifest'):
            self.validate()
        self.target['account_id'] = 'wrong-account'
        with self.assertRaisesRegex(ValueError, 'account'):
            self.validate()
