#include "dfi/loan/loan_comparison.hpp"
#include <stdexcept>

namespace dfi::loan {

std::vector<LoanComparison> LoanComparisonEngine::compare(long double principal, long double annualInterestRate, const std::vector<unsigned int>& tenures)
{
    if (tenures.empty())
        throw std::invalid_argument("At least one tenure option is required.");

    std::vector<LoanComparison> comparisons;
    comparisons.reserve(tenures.size());

    for (const auto tenure : tenures) {
        const LoanInput input{principal, annualInterestRate, tenure};
        comparisons.push_back({tenure, LoanCalculator::calculate(input)});
    }

    return comparisons;
}

} // namespace dfi::loan
