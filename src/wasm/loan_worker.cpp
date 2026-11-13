
#include "dfi/loan/loan_calculator.hpp"

#include <stdexcept>

namespace {

double result_buffer[3] = {};

}

extern "C" {

// Return codes:
// 0 = success
// 1 = invalid input
// 2 = numeric overflow
// 3 = unexpected calculation error

int dfi_calculate_loan(
    double principal,
    double annual_interest_rate,
    unsigned int tenure_months
) noexcept {
    try {
        const dfi::loan::LoanInput input{
            static_cast<long double>(principal),
            static_cast<long double>(annual_interest_rate),
            tenure_months
        };

        const auto result = dfi::loan::LoanCalculator::calculate(input);

        result_buffer[0] = static_cast<double>(result.monthlyEmi);
        result_buffer[1] = static_cast<double>(result.totalInterest);
        result_buffer[2] = static_cast<double>(result.totalRepayment);

        return 0;
    }
    catch (const std::invalid_argument&) {
        return 1;
    }
    catch (const std::overflow_error&) {
        return 2;
    }
    catch (...) {
        return 3;
    }
}

double* dfi_get_result_ptr() noexcept {
    return result_buffer;
}

}
