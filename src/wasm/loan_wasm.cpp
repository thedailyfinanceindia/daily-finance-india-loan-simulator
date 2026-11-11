
#include "dfi/loan/loan_calculator.hpp"
#include "dfi/loan/loan_comparison.hpp"

#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <cmath>
#include <stdexcept>
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

unsigned int read_tenure(const val& value) {
    const double tenure = value.as<double>();

    if (!std::isfinite(tenure) ||
        tenure < 1.0 ||
        tenure > 600.0 ||
        std::floor(tenure) != tenure) {
        throw std::invalid_argument(
            "Each tenure must be a whole number between 1 and 600 months."
        );
    }

    return static_cast<unsigned int>(tenure);
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
}
