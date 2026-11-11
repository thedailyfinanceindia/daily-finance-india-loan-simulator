cmake_minimum_required(VERSION 3.25)
project(DailyFinanceIndiaLoanSimulator VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(dfi_loan_engine src/loan/loan_calculator.cpp)
target_include_directories(dfi_loan_engine PUBLIC include)
target_compile_features(dfi_loan_engine PUBLIC cxx_std_17)

if(MSVC)
    target_compile_options(dfi_loan_engine PRIVATE /W4 /permissive-)
else()
    target_compile_options(dfi_loan_engine PRIVATE -Wall -Wextra -Wpedantic)
endif()

add_executable(dfi_app src/main.cpp)
target_link_libraries(dfi_app PRIVATE dfi_loan_engine)

include(CTest)
if(BUILD_TESTING)
    add_executable(dfi_tests tests/loan_calculator_tests.cpp)
    target_link_libraries(dfi_tests PRIVATE dfi_loan_engine)
    add_test(NAME LoanCalculatorTests COMMAND dfi_tests)
endif()
