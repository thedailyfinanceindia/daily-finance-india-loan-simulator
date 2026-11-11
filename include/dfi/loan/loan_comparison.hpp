#pragma once
#include "dfi/loan/loan_calculator.hpp"
#include <vector>

namespace dfi::loan {
struct LoanComparison {
    unsigned int tenureMonths;
    LoanResult result;
};

class LoanComparisonEngine {
public:
    static std::vector<LoanComparison> compare(long double principal, long double annualInterestRate, const std::vector<unsigned int>& tenures);
};

} // namespace dfi::loan
