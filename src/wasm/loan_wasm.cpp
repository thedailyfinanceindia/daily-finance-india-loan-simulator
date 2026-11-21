
#include "dfi/loan/amortization_simulator.hpp"
#include "dfi/loan/loan_calculator.hpp"
#include "dfi/loan/loan_comparison.hpp"

#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <cmath>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

using emscripten::val;

val make_result(const dfi::loan::LoanResult& result) {
    val output = val::object();

    output.set("monthlyEmi", static_cast<double>(result.monthlyEmi));
    output.set("totalInterest", static_cast<double>(result.totalInterest));
    output.set("totalRepayment", static_cast<double>(result.totalRepayment));

    return output;
}

unsigned int read_tenure_value(double tenure) {
    if (!std::isfinite(tenure) ||
        tenure < 1.0 ||
        tenure > static_cast<double>(dfi::loan::MAX_TENURE_MONTHS) ||
        std::floor(tenure) != tenure) {
        throw std::invalid_argument(
            "Each tenure must be a whole number between 1 and 600 months."
        );
    }

    return static_cast<unsigned int>(tenure);
}

unsigned int read_tenure(const val& value) {
    return read_tenure_value(value.as<double>());
}

val make_projection(const dfi::loan::LoanProjection& projection) {
    val output = val::object();
    output.set("status", dfi::loan::projectionStatusName(projection.status));
    output.set("installments", projection.installments);
    output.set("initialEmi", static_cast<double>(projection.initialEmi));
    output.set("lastEmi", static_cast<double>(projection.lastEmi));
    output.set("endingBalance", static_cast<double>(projection.endingBalance));
    output.set("totalInterest", static_cast<double>(projection.totalInterest));
    output.set(
        "totalRegularPayments",
        static_cast<double>(projection.totalRegularPayments)
    );
    output.set(
        "totalPrepaymentsRequested",
        static_cast<double>(projection.totalPrepaymentsRequested)
    );
    output.set(
        "totalPrepaymentsApplied",
        static_cast<double>(projection.totalPrepaymentsApplied)
    );
    output.set(
        "totalRepayment",
        static_cast<double>(projection.totalRepayment())
    );

    val schedule = val::array();
    for (const auto& month : projection.schedule) {
        val item = val::object();
        item.set("installmentNumber", month.installmentNumber);
        item.set(
            "annualInterestRate",
            static_cast<double>(month.annualInterestRate)
        );
        item.set("openingBalance", static_cast<double>(month.openingBalance));
        item.set("interest", static_cast<double>(month.interest));
        item.set("scheduledEmi", static_cast<double>(month.scheduledEmi));
        item.set("regularPayment", static_cast<double>(month.regularPayment));
        item.set("regularPrincipal", static_cast<double>(month.regularPrincipal));
        item.set(
            "requestedPrepayment",
            static_cast<double>(month.requestedPrepayment)
        );
        item.set(
            "prepaymentApplied",
            static_cast<double>(month.prepaymentApplied)
        );
        item.set("closingBalance", static_cast<double>(month.closingBalance));
        schedule.call<void>("push", item);
    }
    output.set("schedule", schedule);

    return output;
}

val optional_int(const std::optional<int>& value) {
    return value ? val(*value) : val::null();
}

val optional_number(const std::optional<long double>& value) {
    return value
        ? val(static_cast<double>(*value))
        : val::null();
}

val simulate_rate_revision(
    double outstanding_balance,
    double current_rate,
    double current_emi,
    double remaining_tenure_months,
    double revised_rate
) {
    const dfi::loan::LoanSnapshot loan{
        static_cast<long double>(outstanding_balance),
        static_cast<long double>(current_rate),
        static_cast<long double>(current_emi),
        read_tenure_value(remaining_tenure_months)
    };

    const auto simulation =
        dfi::loan::LoanAmortizationSimulator::simulateRateRevision(
            loan,
            static_cast<long double>(revised_rate)
        );

    val output = val::object();
    output.set("baseline", make_projection(simulation.baseline));
    output.set("keepEmi", make_projection(simulation.keepEmi));
    output.set("keepTenure", make_projection(simulation.keepTenure));
    output.set(
        "keepEmiTermChangeMonths",
        optional_int(simulation.keepEmiTermChangeMonths)
    );
    output.set(
        "keepEmiInterestChange",
        optional_number(simulation.keepEmiInterestChange)
    );
    output.set(
        "keepTenureEmiChange",
        optional_number(simulation.keepTenureEmiChange)
    );
    output.set(
        "keepTenureInterestChange",
        optional_number(simulation.keepTenureInterestChange)
    );
    return output;
}

val simulate_prepayments(
    double outstanding_balance,
    double annual_interest_rate,
    double current_emi,
    double remaining_tenure_months,
    const val& events
) {
    if (!events.isArray()) {
        throw std::invalid_argument("Prepayment events must be an array.");
    }

    const unsigned int count = events["length"].as<unsigned int>();
    if (count > 600) {
        throw std::invalid_argument(
            "At most 600 prepayment events are supported."
        );
    }

    std::vector<dfi::loan::PrepaymentEvent> prepayment_events;
    prepayment_events.reserve(count);
    for (unsigned int index = 0; index < count; ++index) {
        const val event = events[index];
        if (event.isNull() ||
            event.isUndefined() ||
            event.isArray() ||
            event.typeOf().as<std::string>() != "object") {
            throw std::invalid_argument(
                "Each prepayment event must be an object."
            );
        }

        prepayment_events.push_back({
            read_tenure(event["installmentNumber"]),
            static_cast<long double>(event["amount"].as<double>())
        });
    }

    const dfi::loan::LoanSnapshot loan{
        static_cast<long double>(outstanding_balance),
        static_cast<long double>(annual_interest_rate),
        static_cast<long double>(current_emi),
        read_tenure_value(remaining_tenure_months)
    };
    const auto simulation =
        dfi::loan::LoanAmortizationSimulator::simulatePrepayments(
            loan,
            prepayment_events
        );

    val output = val::object();
    output.set("baseline", make_projection(simulation.baseline));
    output.set("reduceTenure", make_projection(simulation.reduceTenure));
    output.set("reduceEmi", make_projection(simulation.reduceEmi));
    output.set(
        "reduceTenureInstallmentsSaved",
        optional_int(simulation.reduceTenureInstallmentsSaved)
    );
    output.set(
        "reduceTenureInterestSaved",
        optional_number(simulation.reduceTenureInterestSaved)
    );
    output.set(
        "reduceEmiInstallmentsSaved",
        optional_int(simulation.reduceEmiInstallmentsSaved)
    );
    output.set(
        "reduceEmiInterestSaved",
        optional_number(simulation.reduceEmiInterestSaved)
    );
    return output;
}

val calculate_loan(
    double principal,
    double annual_interest_rate,
    unsigned int tenure_months
) {
    const dfi::loan::LoanInput input{
        static_cast<long double>(principal),
        static_cast<long double>(annual_interest_rate),
        tenure_months
    };

    return make_result(dfi::loan::LoanCalculator::calculate(input));
}

val compare_loan_tenures(
    double principal,
    double annual_interest_rate,
    const val& tenures
) {
    if (!tenures.isArray()) {
        throw std::invalid_argument("Tenures must be an array.");
    }

    const unsigned int count = tenures["length"].as<unsigned int>();

    if (count == 0) {
        throw std::invalid_argument("At least one tenure is required.");
    }

    std::vector<unsigned int> tenure_values;
    tenure_values.reserve(count);

    for (unsigned int i = 0; i < count; ++i) {
        tenure_values.push_back(read_tenure(tenures[i]));
    }

    const auto comparisons = dfi::loan::LoanComparisonEngine::compare(
        static_cast<long double>(principal),
        static_cast<long double>(annual_interest_rate),
        tenure_values
    );

    val output = val::array();

    for (const auto& comparison : comparisons) {
        val item = val::object();

        item.set("tenureMonths", comparison.tenureMonths);
        item.set("monthlyEmi",
                 static_cast<double>(comparison.result.monthlyEmi));
        item.set("totalInterest",
                 static_cast<double>(comparison.result.totalInterest));
        item.set("totalRepayment",
                 static_cast<double>(comparison.result.totalRepayment));

        output.call<void>("push", item);
    }

    return output;
}

} // namespace

EMSCRIPTEN_BINDINGS(dfi_loan_module) {
    emscripten::function("calculateLoan", &calculate_loan);
    emscripten::function("compareLoanTenures", &compare_loan_tenures);
    emscripten::function("simulateRateRevision", &simulate_rate_revision);
    emscripten::function("simulatePrepayments", &simulate_prepayments);
}
