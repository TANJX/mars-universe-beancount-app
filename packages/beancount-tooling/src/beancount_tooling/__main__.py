import runpy
from pathlib import Path


def run_extract():
    from beancount_tooling.extract import main

    main()


def run_update_stock_price():
    runpy.run_path(
        str(Path(__file__).parent / "update_stock_price.py"), run_name="__main__"
    )


def run_generate_forecast():
    from beancount_tooling.generate_forecast import main

    main()
