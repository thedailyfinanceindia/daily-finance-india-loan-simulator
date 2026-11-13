
cmake_minimum_required(VERSION 3.25)
project(DailyFinanceIndiaLoanSimulator VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(dfi_loan_engine
    src/loan/loan_calculator.cpp
    src/loan/loan_comparison.cpp
)

target_include_directories(dfi_loan_engine PUBLIC include)

if(MSVC)
    target_compile_options(dfi_loan_engine PRIVATE /W4 /permissive-)
else()
    target_compile_options(dfi_loan_engine PRIVATE -Wall -Wextra -Wpedantic)
endif()

# Native application
if(NOT EMSCRIPTEN)
    add_executable(dfi_app src/main.cpp)
    target_link_libraries(dfi_app PRIVATE dfi_loan_engine)
endif()

# Native tests
include(CTest)

if(BUILD_TESTING AND NOT EMSCRIPTEN)
    add_executable(dfi_tests tests/loan_calculator_tests.cpp)
    target_link_libraries(dfi_tests PRIVATE dfi_loan_engine)
    add_test(NAME LoanCalculatorTests COMMAND dfi_tests)

    add_executable(dfi_comparison_tests tests/loan_comparison_tests.cpp)
    target_link_libraries(dfi_comparison_tests PRIVATE dfi_loan_engine)
    add_test(NAME LoanComparisonTests COMMAND dfi_comparison_tests)
endif()

# WebAssembly browser module
if(EMSCRIPTEN)
    add_executable(dfi_loan_wasm
        src/wasm/loan_wasm.cpp
    )

    target_link_libraries(dfi_loan_wasm PRIVATE dfi_loan_engine)

    set_target_properties(dfi_loan_wasm PROPERTIES
        OUTPUT_NAME "loan_calculator"
        SUFFIX ".js"
    )

    target_link_options(dfi_loan_wasm PRIVATE
        "-lembind"
        "-sALLOW_MEMORY_GROWTH=1"
        "-sMODULARIZE=1"
        "-sEXPORT_NAME=createLoanCalculator"
        "-sENVIRONMENT=web"
    )

    set_target_properties(dfi_loan_wasm PROPERTIES
        RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/web"
    )
    
    # Cloudflare Workers WebAssembly module
    add_executable(dfi_loan_worker_wasm
        src/wasm/loan_worker.cpp
    )

    target_link_libraries(dfi_loan_worker_wasm
        PRIVATE dfi_loan_engine
    )

    target_compile_options(dfi_loan_worker_wasm
        PRIVATE -fexceptions
    )

    set_target_properties(dfi_loan_worker_wasm PROPERTIES
        OUTPUT_NAME "loan_worker"
        SUFFIX ".wasm"
        RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/worker"
    )

    target_link_options(dfi_loan_worker_wasm PRIVATE
        "-fexceptions"
        "-sSTANDALONE_WASM=1"
        "-sFILESYSTEM=0"
        "-sALLOW_MEMORY_GROWTH=1"
        "-sEXPORTED_FUNCTIONS=['_dfi_calculate_loan','_dfi_get_result_ptr']"
        "-Wl,--no-entry"
    )

endif()
