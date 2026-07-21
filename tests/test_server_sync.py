from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


class ServerSyncTests(unittest.TestCase):
    def test_compose_tracks_tested_github_image(self):
        compose = (ROOT / "compose.yml").read_text(encoding="utf-8")
        self.assertIn("ghcr.io/vivata-pte-ltd/building-envelope-thermal-calculator:server-latest", compose)
        self.assertIn("pull_policy: always", compose)
        self.assertNotIn("build: .", compose)

    def test_tested_image_is_published_once_with_full_commit_and_signature(self):
        workflow = (ROOT / ".github" / "workflows" / "server-ci.yml").read_text(encoding="utf-8")
        self.assertEqual(workflow.count("docker build "), 1)
        self.assertIn("ghcr.io/vivata-pte-ltd/building-envelope-thermal-calculator", workflow)
        self.assertIn('--build-arg APP_GIT_SHA="$GITHUB_SHA"', workflow)
        self.assertIn('server-${GITHUB_SHA}', workflow)
        self.assertNotIn('server-${GITHUB_SHA::12}', workflow)
        self.assertIn("cosign sign --yes", workflow)
        self.assertIn("id-token: write", workflow)
        self.assertIn("server-latest", workflow)
        self.assertIn("--prefer-index=false", workflow)
        self.assertEqual(workflow.count('docker buildx imagetools inspect "$latest"'), 2)
        self.assertIn("= \"$existing_digest\"", workflow)
        self.assertIn("= \"$digest\"", workflow)
        self.assertIn("cancel-in-progress: ${{ github.event_name == 'pull_request' }}", workflow)

    def test_windows_sync_is_health_checked_and_rolls_back(self):
        sync = (ROOT / "server" / "Sync_Server_From_GitHub.bat").read_text(encoding="utf-8")
        self.assertIn("docker compose pull", sync)
        self.assertIn("VivaTEQ-Envelope-GitHub-Sync.lock", sync)
        self.assertIn("docker inspect", sync)
        self.assertIn("APP_GIT_SHA=", sync)
        self.assertIn("application/vnd.github.sha", sync)
        self.assertIn("cosign-windows-amd64.exe", sync)
        self.assertIn("--certificate-identity", sync)
        self.assertIn("NEW_DIGEST", sync)
        self.assertIn('set "SERVER_IMAGE=!NEW_DIGEST!"', sync)
        self.assertIn("EXPECTED_SHA", sync)
        self.assertIn("ConvertFrom-Json", sync)
        self.assertIn("FRESH_MAIN_SHA", sync)
        self.assertIn("--wait --wait-timeout 120", sync)
        self.assertIn("Starting rollback", sync)
        self.assertIn('set "SERVER_IMAGE=!OLD_DIGEST!"', sync)
        self.assertIn("Previous image signature could not be reverified", sync)
        self.assertIn("RESTORED_IMAGE", sync)
        self.assertIn("ROLLBACK_HEALTH", sync)
        self.assertIn("--pull never", sync)
        self.assertNotIn("GHCR_TOKEN", sync)
        self.assertNotIn("--password", sync)
        self.assertNotIn("Authorization:", sync)

    def test_windows_installer_registers_fifteen_minute_check(self):
        installer = (ROOT / "server" / "Install_Automatic_GitHub_Sync.bat").read_text(encoding="utf-8")
        self.assertIn("schtasks /Create", installer)
        self.assertIn("/SC MINUTE /MO 15", installer)
        self.assertIn("Sync_Server_From_GitHub.bat", installer)
        self.assertIn("Sigstore.Cosign", installer)
        self.assertIn('/TR "\\\"%SYNC_SCRIPT%\\\""', installer)

    def test_local_build_override_remains_available(self):
        override = (ROOT / "compose.local.yml").read_text(encoding="utf-8")
        self.assertIn("build:", override)
        self.assertIn("pull_policy: never", override)
        self.assertIn("APP_GIT_SHA", override)


if __name__ == "__main__":
    unittest.main()
