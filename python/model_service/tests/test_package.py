import model_service


def test_package_imports_and_reports_a_version() -> None:
    assert model_service.__version__ == "1.0.0"
