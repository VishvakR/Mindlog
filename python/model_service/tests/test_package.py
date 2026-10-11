import model_service


def test_package_imports_and_reports_a_version() -> None:
    assert model_service.__version__ == "0.0.0"
