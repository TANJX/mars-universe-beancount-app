"""merge_and_write_file on synthetic month files."""

from datetime import date

from beancount_tooling.forecast.file_handler import merge_and_write_file
from beancount_tooling.forecast.models import TemplatePosting, TemplateTransaction


def template(tid, when, amount, payee="Demo Landlord", narration="2030-10 Rent"):
    return TemplateTransaction(
        tid=tid,
        date=when,
        flag="!",
        payee=payee,
        narration=narration,
        postings=[
            TemplatePosting("Expenses:Home:Rent", amount),
            TemplatePosting("Liabilities:Payable:Rent", None),
        ],
    )


RENT_TEMPLATES = [
    template("rent_demo:2030-10", date(2030, 10, 1), 1000.0),
    template("rent_demo_utility:2030-10", date(2030, 10, 1), 30.0, narration="Utility"),
]


def rent_file(tmp_path):
    bean = tmp_path / "rent.bean"
    bean.write_text(
        '2030-10-01 ! "Demo Landlord" "2030-10 Rent"\n'
        "  Expenses:Home:Rent                           1000.00 USD\n"
        '    tid: "rent_demo:2030-10"\n'
        "  Liabilities:Payable:Rent\n"
        "\n"
        '2030-10-01 ! "Demo Landlord" "Utility"\n'
        "  Expenses:Home:Rent                             30.00 USD\n"
        '    tid: "rent_demo_utility:2030-10"\n'
        "  Liabilities:Payable:Rent\n"
    )
    return bean


def test_mid_month_regeneration_keeps_past_dated_rent(tmp_path):
    bean = rent_file(tmp_path)
    before = bean.read_text()
    merge_and_write_file(bean, RENT_TEMPLATES, today=date(2030, 10, 15))
    assert bean.read_text().strip() == before.strip()


def test_past_forecast_with_cleared_counterpart_is_dropped(tmp_path):
    bean = rent_file(tmp_path)
    bean.write_text(
        bean.read_text()
        + "\n"
        + '2030-10-02 * "Demo Landlord" "2030-10 Rent"\n'
        + "  Expenses:Home:Rent                           1000.00 USD\n"
        + '    tid: "rent_demo:2030-10"\n'
        + "  Liabilities:Payable:Rent\n"
    )
    merge_and_write_file(bean, RENT_TEMPLATES, today=date(2030, 10, 15))
    text = bean.read_text()
    assert text.count('tid: "rent_demo:2030-10"') == 1  # only the cleared one
    assert '2030-10-02 * "Demo Landlord"' in text
    assert text.count('tid: "rent_demo_utility:2030-10"') == 1


def test_past_forecasts_merge_with_future_templates_in_date_order(tmp_path):
    bean = rent_file(tmp_path)
    future = template("demo_insurance:2030-10", date(2030, 10, 20), 50.0, "Demo Ins")
    merge_and_write_file(bean, [*RENT_TEMPLATES, future], today=date(2030, 10, 15))
    text = bean.read_text()
    order = [
        text.index('tid: "rent_demo:2030-10"'),
        text.index('tid: "rent_demo_utility:2030-10"'),
        text.index('tid: "demo_insurance:2030-10"'),
    ]
    assert order == sorted(order)


def test_actuals_block_untouched_and_not_duplicated(tmp_path):
    bean = rent_file(tmp_path)
    actual = (
        '2030-10-05 * "Demo Shop" ""\n'
        "  Expenses:Home:Rent                             12.00 USD\n"
        "  Liabilities:Payable:Rent\n"
    )
    bean.write_text(bean.read_text() + "\n" + actual)
    merge_and_write_file(bean, RENT_TEMPLATES, today=date(2030, 10, 15))
    merge_and_write_file(bean, RENT_TEMPLATES, today=date(2030, 10, 15))
    text = bean.read_text()
    assert text.count('tid: "rent_demo:2030-10"') == 1
    assert text.endswith(actual)


def test_future_template_replaces_existing_entry(tmp_path):
    bean = rent_file(tmp_path)
    merge_and_write_file(
        bean,
        [template("rent_demo:2030-10", date(2030, 10, 1), 1100.0)],
        today=date(2030, 9, 20),
    )
    text = bean.read_text()
    assert "1100.00 USD" in text and "1000.00 USD" not in text
    # Not yet past, and no longer templated: dropped as before.
    assert "rent_demo_utility" not in text
