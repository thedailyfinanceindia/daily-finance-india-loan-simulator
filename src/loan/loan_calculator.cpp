#include "dfi/loan/loan_calculator.hpp"
#include <cmath>
#include <stdexcept>

namespace dfi::loan {

LoanResult LoanCalculator::calculate(const LoanInput& input)
{
    if (!std::isfinite(input.principal) || input.principal <= 0.0L)
        throw std::invalid_argument("Principal must be positive and finite.");

    if (!std::isfinite(input.annualInterestRate) || input.annualInterestRate < 0.0L)
        throw std::invalid_argument("Interest rate must be non-negative and finite.");

    if (input.tenureMonths == 0 || input.tenureMonths > 600)
        throw std::invalid_argument("Tenure must be between 1 and 600 months.");

    const long double months = static_cast<long double>(input.tenureMonths);
    const long double monthlyRate = input.annualInterestRate / 1200.0L;

    long double emi = 0.0L;

    if (monthlyRate == 0.0L) {
        emi = input.principal / months;
    } else {
        const long double denominator = -std::expm1(-months * std::log1p(monthlyRate));
        emi = input.principal * monthlyRate / denominator;
    }

    const long double repayment = emi * months;
    const long double interest = repayment - input.principal;

    if (!std::isfinite(emi) || !std::isfinite(repayment) || !std::isfinite(interest))
        throw std::overflow_error("Loan calculation exceeded the supported numeric range.");

    return { emi, interest, repayment };
}

} // namespace dfi::loan
